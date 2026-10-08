/**
 * Conversation lifecycle.
 *
 * A conversation is either a direct message or a group. Private conversations are addressable only
 * through an existing trust boundary: every invitee must already share an active space with the
 * creator, so a guessed user id cannot be used to open a room with an unrelated account.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "../encoding";
import { profileBannerUrl, profileImageUrl } from "../profile-images";
import { respondError } from "../http/responses";
import { matrixUserId, stringArray } from "../http/validation";
import { directConversationIsBlocked } from "../moderation/blocks";
import { conversationChannelAuthorization, isMetadataChannel } from "../servers/channel-access";
import { clearMembershipCacheFor } from "../realtime";

export const conversationRoutes = new Elysia()
  .post("/v1/conversations", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const memberIds = [...new Set((body.memberUserIds ?? []).filter((id) => id !== user.id))];
      if (body.kind === "dm" && memberIds.length !== 1) {
        return respondError(set, 400, "dm_requires_one_other_member");
      }

      const existingUsers = memberIds.length === 0
        ? []
        : await db<{ id: string }[]>`
            select id from users where id in ${db(memberIds)}
          `;
      if (existingUsers.length !== memberIds.length) return respondError(set, 400, "unknown_member");
      if (body.kind === "dm" && memberIds.length > 0) {
        const blocked = await db<{ blocked_user_id: string }[]>`
          select distinct blocked_user_id from user_blocks
          where (blocker_user_id = ${user.id} and blocked_user_id in ${db(memberIds)})
             or (blocked_user_id = ${user.id} and blocker_user_id in ${db(memberIds)})
        `;
        if (blocked.length > 0) return respondError(set, 403, "blocked_user");
      }

      // Private conversations are addressable only through an existing trust
      // boundary. A caller cannot use a guessed user id to create a room with
      // an unrelated account; every invitee must share an active server with
      // the creator.
      const sharedMembers = memberIds.length === 0
        ? []
        : await db<{ user_id: string }[]>`
            select distinct target.user_id
            from server_members mine
            join server_members target on target.server_id = mine.server_id
              and target.left_at is null
            join servers s on s.id = mine.server_id and s.deactivated_at is null
            where mine.user_id = ${user.id}
              and mine.left_at is null
              and target.user_id in ${db(memberIds)}
          `;
      if (sharedMembers.length !== memberIds.length) return respondError(set, 403, "conversation_member_not_shared");

      let metadata: Buffer;
      try {
        metadata = body.encryptedMetadata
          ? decodeBase64(body.encryptedMetadata, "encryptedMetadata", 64 * 1024, true)
          : Buffer.alloc(0);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const conversation = await db.begin(async (transaction) => {
        if (body.kind === "dm") {
          const otherUserId = memberIds[0];
          const pairKey = [user.id, otherUserId].sort().join(":");
          // Serialize creation for a pair so two tabs cannot create duplicate
          // direct-message rooms at the same time.
          await transaction`select pg_advisory_xact_lock(hashtextextended(${pairKey}, 0))`;
          const [existing] = await transaction<{ id: string; created_at: Date; left_at: Date | null }[]>`
            select c.id, c.created_at, mine.left_at
            from conversations c
            join conversation_members mine
              on mine.conversation_id = c.id and mine.user_id = ${user.id}
            join conversation_members other_member
              on other_member.conversation_id = c.id and other_member.user_id = ${otherUserId}
            where c.kind = 'dm' and other_member.left_at is null
            order by c.created_at asc, c.id asc
            limit 1
            for update of c
          `;
          if (existing) {
            if (existing.left_at) {
              await transaction`
                update conversation_members
                set left_at = null, joined_at = now(), role = 'member'
                where conversation_id = ${existing.id} and user_id = ${user.id}
              `;
            }
            return { id: existing.id, kind: "dm", created_at: existing.created_at, reused: true };
          }
        }

        const [created] = await transaction<{ id: string; kind: string; created_at: Date }[]>`
          insert into conversations (kind, encrypted_metadata, created_by)
          values (${body.kind}, ${metadata}, ${user.id})
          returning id, kind, created_at
        `;

        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          values (${created.id}, ${user.id}, 'owner')
        `;
        for (const memberId of memberIds) {
          await transaction`
            insert into conversation_members (conversation_id, user_id, role)
            values (${created.id}, ${memberId}, 'member')
          `;
        }

        return { ...created, reused: false };
      });

      set.status = conversation.reused ? 200 : 201;
      return { conversation: { id: conversation.id, kind: conversation.kind, createdAt: conversation.created_at } };
    }, {
      body: t.Object({
        kind: t.Union([t.Literal("dm"), t.Literal("group")]),
        memberUserIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 100 })),
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
      }),
    })
    .get("/v1/conversations", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const conversations = await db<{
        id: string;
        kind: string;
        encrypted_metadata: Buffer;
        created_at: Date;
        member_display_names: string[];
      }[]>`
        select c.id, c.kind, c.encrypted_metadata, c.created_at,
          coalesce(
            array_agg(other_user.display_name order by other_member.joined_at)
              filter (where other_member.user_id <> ${user.id}),
            array[]::text[]
          ) as member_display_names
        from conversations c
        join conversation_members m on m.conversation_id = c.id
        join conversation_members other_member on other_member.conversation_id = c.id
          and other_member.user_id <> ${user.id} and other_member.left_at is null
        join users other_user on other_user.id = other_member.user_id
        where m.user_id = ${user.id} and m.left_at is null
          and not exists (
            select 1 from channels channel_filter where channel_filter.conversation_id = c.id
          )
          and not (
            c.kind = 'dm' and exists (
              select 1 from conversation_members blocked_member
              join user_blocks b on (b.blocker_user_id = ${user.id} and b.blocked_user_id = blocked_member.user_id)
                or (b.blocked_user_id = ${user.id} and b.blocker_user_id = blocked_member.user_id)
              where blocked_member.conversation_id = c.id
                and blocked_member.user_id <> ${user.id} and blocked_member.left_at is null
            )
          )
          and not (
            c.kind = 'dm' and exists (
              select 1
              from conversations older
              join conversation_members older_mine
                on older_mine.conversation_id = older.id
                and older_mine.user_id = ${user.id} and older_mine.left_at is null
              join conversation_members older_other
                on older_other.conversation_id = older.id
                and older_other.user_id = other_member.user_id and older_other.left_at is null
              where older.kind = 'dm'
                and (older.created_at, older.id) < (c.created_at, c.id)
            )
          )
        group by c.id, c.kind, c.encrypted_metadata, c.created_at
        order by c.created_at desc
      `;

      return {
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          kind: conversation.kind,
          encryptedMetadata: encodeBase64(conversation.encrypted_metadata),
          memberDisplayNames: conversation.member_display_names,
          createdAt: conversation.created_at,
        })),
      };
    })
    .get("/v1/conversations/:conversationId/members", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (await directConversationIsBlocked(params.conversationId, user.id)) return respondError(set, 403, "blocked_user");
      const channelContext = await conversationChannelAuthorization(params.conversationId, user.id);
      if (channelContext) {
        const channelAccess = channelContext.access;
        if (!channelAccess) return respondError(set, 403, "channel_not_visible");
        if (!channelAccess.canView && !await isMetadataChannel(channelContext.channel.server_id, channelContext.channel.id)) {
          return respondError(set, 403, "channel_not_visible");
        }
      }

      const [membership] = await db<{ user_id: string }[]>`
        select user_id from conversation_members
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      if (!membership) return respondError(set, 403, "not_a_conversation_member");

      const members = await db<{
        id: string;
        username: string;
        display_name: string;
        profile_image_storage_key: string | null;
        profile_banner_storage_key: string | null;
        role_ids: string[];
      }[]>`
        select u.id, u.username, u.display_name, u.profile_image_storage_key,
          u.profile_banner_storage_key,
          coalesce(array_agg(smr.role_id order by smr.assigned_at asc) filter (where smr.role_id is not null), array[]::uuid[]) as role_ids
        from conversation_members m
        join users u on u.id = m.user_id
        left join channels c on c.conversation_id = m.conversation_id
        left join server_member_roles smr on smr.server_id = c.server_id and smr.user_id = m.user_id
        where m.conversation_id = ${params.conversationId} and m.left_at is null
        group by u.id, u.username, u.display_name, u.profile_image_storage_key,
          u.profile_banner_storage_key, m.joined_at
        order by m.joined_at asc
      `;
      return {
        members: members.map((member) => ({
          userId: member.id,
          matrixUserId: matrixUserId(member.id),
            username: member.username,
            displayName: member.display_name,
            avatarUrl: profileImageUrl(member.id, member.profile_image_storage_key),
            bannerUrl: profileBannerUrl(member.id, member.profile_banner_storage_key),
            roleIds: stringArray(member.role_ids),
          })),
      };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
    })
    .delete("/v1/conversations/:conversationId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const [conversation] = await db<{ kind: string; user_id: string }[]>`
        select c.kind, cm.user_id
        from conversations c
        join conversation_members cm on cm.conversation_id = c.id
        where c.id = ${params.conversationId} and cm.user_id = ${user.id} and cm.left_at is null
      `;
      if (!conversation) return respondError(set, 404, "conversation_not_found");
      if (conversation.kind === "channel") return respondError(set, 409, "cannot_delete_server_channel");

      await db`
        update conversation_members
        set left_at = coalesce(left_at, now())
        where conversation_id = ${params.conversationId} and user_id = ${user.id} and left_at is null
      `;
      // Leaving is a self-service revocation, so this user's own realtime subscriptions must stop
      // delivering straight away rather than after the membership cache expires.
      clearMembershipCacheFor(params.conversationId, user.id);
      return { deleted: true };
    }, {
      params: t.Object({ conversationId: t.String({ format: "uuid" }) }),
    });
