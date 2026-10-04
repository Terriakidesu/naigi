/**
 * Conversation membership projection for space channels.
 *
 * A channel's conversation membership is derived state: it mirrors which space members can reach
 * that channel. Whenever a role, a grant, or a membership changes, this recomputes it, which is
 * what makes a permission change take effect for message history as well as for new sends.
 */

import { db } from "../db/client";
import { clearMembershipCacheFor } from "../realtime";

/** Grants every active member the `everyone` role so the access tables have something to join. */
async function ensureEveryoneRoleAssignments(serverId: string) {
  await db`
    insert into server_member_roles (server_id, user_id, role_id)
    select sm.server_id, sm.user_id, sr.id
    from server_members sm
    join server_roles sr on sr.server_id = sm.server_id
      and sr.system_key = 'everyone'
    where sm.server_id = ${serverId}
      and sm.left_at is null
    on conflict do nothing
  `;
}

export async function syncChannelConversationMembership(serverId: string, channelId: string) {
  await ensureEveryoneRoleAssignments(serverId);

  const [channel] = await db<{ conversation_id: string; category_id: string | null }[]>`
    select conversation_id, category_id from channels
    where id = ${channelId} and server_id = ${serverId} and archived_at is null
  `;
  if (!channel) return;

  const [anchor] = await db<{ id: string }[]>`
    select id from channels
    where server_id = ${serverId} and archived_at is null
    order by created_at asc, id asc
    limit 1
  `;
  const isAnchor = anchor?.id === channelId;

  await db.begin(async (transaction) => {
    // A member reaches the channel when it is the anchor, when they own the space, or when one of
    // their non-default roles grants view on the channel or its category.
    await transaction`
      insert into conversation_members (conversation_id, user_id, role)
      select ${channel.conversation_id}, sm.user_id, case when sm.role = 'owner' then 'owner' else 'member' end
      from server_members sm
      join servers s on s.id = sm.server_id
      where sm.server_id = ${serverId} and sm.left_at is null
        and (
          ${isAnchor}
          or sm.user_id = s.owner_id
          or exists (
            select 1
            from server_member_roles smr
            join server_roles sr on sr.id = smr.role_id
            where smr.server_id = sm.server_id and smr.user_id = sm.user_id
              and sr.permissions->>'view_channels' = 'true'
              and not (
                sr.system_key is not distinct from 'everyone'
                and exists (
                  select 1
                  from server_member_roles elevated_smr
                  join server_roles elevated_sr on elevated_sr.id = elevated_smr.role_id
                  where elevated_smr.server_id = smr.server_id
                    and elevated_smr.user_id = smr.user_id
                    and elevated_sr.system_key is distinct from 'everyone'
                )
              )
              and (
                sr.view_all_channels
                or exists (
                  select 1 from server_role_channel_access src
                  where src.role_id = sr.id and src.channel_id = ${channelId}
                    and (src.can_view or src.can_upload)
                )
                or exists (
                  select 1 from server_role_category_access src
                  where src.role_id = sr.id and src.category_id = ${channel.category_id}
                    and (src.can_view or src.can_upload)
                )
              )
          )
        )
      on conflict (conversation_id, user_id) do update set left_at = null, joined_at = now()
    `;

    // The mirror image: anyone who no longer qualifies leaves. The anchor never empties, so a space
    // always retains at least one channel conversation.
    await transaction`
      update conversation_members cm
      set left_at = coalesce(cm.left_at, now())
      where cm.conversation_id = ${channel.conversation_id}
        and cm.left_at is null
        and not ${isAnchor}
        and not exists (
          select 1
          from server_members sm
          join servers s on s.id = sm.server_id
          where sm.server_id = ${serverId} and sm.user_id = cm.user_id and sm.left_at is null
            and (
              sm.user_id = s.owner_id
              or exists (
                select 1
                from server_member_roles smr
                join server_roles sr on sr.id = smr.role_id
                where smr.server_id = sm.server_id and smr.user_id = sm.user_id
                  and sr.permissions->>'view_channels' = 'true'
                  and not (
                    sr.system_key is not distinct from 'everyone'
                    and exists (
                      select 1
                      from server_member_roles elevated_smr
                      join server_roles elevated_sr on elevated_sr.id = elevated_smr.role_id
                      where elevated_smr.server_id = smr.server_id
                        and elevated_smr.user_id = smr.user_id
                        and elevated_sr.system_key is distinct from 'everyone'
                    )
                  )
                  and (
                    sr.view_all_channels
                      or exists (
                        select 1 from server_role_channel_access src
                        where src.role_id = sr.id and src.channel_id = ${channelId}
                          and (src.can_view or src.can_upload)
                      )
                      or exists (
                        select 1 from server_role_category_access src
                        where src.role_id = sr.id and src.category_id = ${channel.category_id}
                          and (src.can_view or src.can_upload)
                      )
                  )
              )
            )
        )
    `;
  });
}

/**
 * Recomputes membership for every live channel in a space.
 *
 * Called after any change that can alter who reaches which channel: role assignment, permission
 * edits, channel grants, category grants, and member join or leave.
 */
export async function syncServerChannelMemberships(serverId: string) {
  const channels = await db<{ id: string; conversation_id: string }[]>`
    select id, conversation_id from channels where server_id = ${serverId} and archived_at is null
  `;
  for (const channel of channels) {
    await syncChannelConversationMembership(serverId, channel.id);
    // A role or channel-access change can revoke membership here, so any memoised membership for
    // the channel's conversation is stale and must not keep authorising realtime delivery.
    clearMembershipCacheFor(channel.conversation_id);
  }
}
