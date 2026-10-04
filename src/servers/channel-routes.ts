/**
 * Channels and categories within a space.
 *
 * The oldest live channel is the space anchor: every member reaches it regardless of role grants,
 * it is what membership sync measures against, and it cannot be deleted. Names stay encrypted
 * throughout; nothing in this module decrypts metadata.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "../encoding";
import { recordServerAudit } from "../http/audit";
import { respondError } from "../http/responses";
import { decodeEncryptedMetadata } from "../http/validation";
import { channelAuthorization, visibleServerChannels } from "./channel-access";
import { syncChannelConversationMembership } from "./membership";
import {
  hasAnyServerPermission,
  hasServerPermission,
  serverAuthorization,
  serverMembership,
} from "./permissions";

export const channelRoutes = new Elysia()
  .get("/v1/servers/:serverId/channels", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");

      const channels = await visibleServerChannels(params.serverId, user.id);
      return {
        channels: channels.map(({ channel, canUpload, canSend }) => ({
          id: channel.id,
          serverId: channel.server_id,
          conversationId: channel.conversation_id,
          encryptedMetadata: encodeBase64(channel.encrypted_metadata),
          categoryId: channel.category_id,
          kind: channel.kind,
          position: channel.position,
          canView: true,
          canUpload,
          canSend,
          createdAt: channel.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/channels", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "create_channels")) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const created = await db.begin(async (transaction) => {
        const [position] = await transaction<{ next_position: number }[]>`
          select coalesce(max(position), -1) + 1 as next_position
          from channels where server_id = ${params.serverId} and archived_at is null
        `;
        if (body.categoryId !== null && body.categoryId !== undefined) {
          const [category] = await transaction<{ id: string }[]>`
            select id from categories
            where id = ${body.categoryId} and server_id = ${params.serverId} and archived_at is null
          `;
          if (!category) return { error: "category_not_found" as const };
        }
        const [conversation] = await transaction<{ id: string }[]>`
          insert into conversations (kind, created_by)
          values ('channel', ${user.id})
          returning id
        `;
        const channelKind = body.kind ?? "text";
        const [channel] = await transaction<{ id: string; kind: string; position: number; created_at: Date }[]>`
          insert into channels (server_id, conversation_id, created_by, encrypted_metadata, category_id, kind, position)
          values (${params.serverId}, ${conversation.id}, ${user.id}, ${metadata}, ${body.categoryId ?? null}, ${channelKind}, ${body.position ?? position.next_position})
          returning id, kind, position, created_at
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          select ${conversation.id}, sm.user_id, case when sm.role = 'owner' then 'owner' else 'member' end
          from server_members sm
          where sm.server_id = ${params.serverId} and sm.left_at is null
            and (
              sm.user_id = ${user.id}
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
                      select 1 from server_role_category_access src
                      where src.role_id = sr.id and src.category_id = ${body.categoryId ?? null}
                        and (src.can_view or src.can_upload)
                    )
                  )
              )
            )
          on conflict (conversation_id, user_id) do nothing
        `;
        return { channel, conversationId: conversation.id };
      });

      if ("error" in created) return respondError(set, 404, "category_not_found");
      await recordServerAudit(params.serverId, user.id, "channel.created", created.channel.id);
      set.status = 201;
      return {
        channel: {
          id: created.channel.id,
          serverId: params.serverId,
          conversationId: created.conversationId,
          encryptedMetadata: encodeBase64(metadata),
          categoryId: body.categoryId ?? null,
          kind: created.channel.kind,
          position: created.channel.position,
          canView: true,
          canUpload: true,
          canSend: true,
          createdAt: created.channel.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        categoryId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        kind: t.Optional(t.Union([t.Literal("text"), t.Literal("voice")])),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .patch("/v1/servers/:serverId/channels/:channelId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "edit_channels", "reorder_channels")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.encryptedMetadata !== undefined && !hasAnyServerPermission(membership, "manage_channels", "edit_channels")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.categoryId !== undefined && !hasAnyServerPermission(membership, "manage_channels", "edit_channels")) return respondError(set, 403, "insufficient_server_permissions");
      if (body.position !== undefined && !hasAnyServerPermission(membership, "manage_channels", "reorder_channels")) return respondError(set, 403, "insufficient_server_permissions");

      const [existing] = await db<{ id: string; encrypted_metadata: Buffer }[]>`
        select id, encrypted_metadata from channels
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!existing) return respondError(set, 404, "channel_not_found");

      if (body.categoryId !== undefined && body.categoryId !== null) {
        const [category] = await db<{ id: string }[]>`
          select id from categories
          where id = ${body.categoryId} and server_id = ${params.serverId} and archived_at is null
        `;
        if (!category) return respondError(set, 404, "category_not_found");
      }

      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined
          ? undefined
          : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      type ChannelUpdateRow = {
        id: string;
        server_id: string;
        conversation_id: string;
        encrypted_metadata: Buffer;
        category_id: string | null;
        kind: string;
        position: number;
        created_at: Date;
      };
      const channelRows = body.categoryId === undefined
        ? await db<ChannelUpdateRow[]>`
            update channels
            set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
                position = coalesce(${body.position ?? null}, position)
            where id = ${existing.id}
            returning id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
          `
        : await db<ChannelUpdateRow[]>`
            update channels
            set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
                category_id = ${body.categoryId},
                position = coalesce(${body.position ?? null}, position)
            where id = ${existing.id}
            returning id, server_id, conversation_id, encrypted_metadata, category_id, kind, position, created_at
          `;
      const channel = channelRows[0];
      if (!channel) return respondError(set, 404, "channel_not_found");
      const access = await channelAuthorization(params.serverId, user.id, channel.id);
      await recordServerAudit(params.serverId, user.id, "channel.updated", channel.id);
      return {
        channel: {
          id: channel.id,
          serverId: channel.server_id,
          conversationId: channel.conversation_id,
          encryptedMetadata: encodeBase64(channel.encrypted_metadata),
          categoryId: channel.category_id,
          kind: channel.kind,
          position: channel.position,
          canView: Boolean(access?.canView),
          canUpload: Boolean(access?.canUpload),
          canSend: Boolean(access && hasServerPermission(access.authorization, "send_messages")),
          createdAt: channel.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        categoryId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/channels/:channelId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "archive_channels")) return respondError(set, 403, "insufficient_server_permissions");
      const [activeCount] = await db<{ count: number }[]>`
        select count(*)::int as count from channels
        where server_id = ${params.serverId} and archived_at is null
      `;
      if (activeCount.count <= 1) return respondError(set, 409, "cannot_archive_last_channel");
      const [metadataAnchor] = await db<{ id: string }[]>`
        select id from channels
        where server_id = ${params.serverId}
        order by created_at asc
        limit 1
      `;
      if (metadataAnchor?.id === params.channelId) return respondError(set, 409, "cannot_archive_metadata_channel");
      const [archived] = await db<{ id: string }[]>`
        update channels set archived_at = coalesce(archived_at, now())
        where id = ${params.channelId} and server_id = ${params.serverId} and archived_at is null
        returning id
      `;
      if (!archived) return respondError(set, 404, "channel_not_found");
      await recordServerAudit(params.serverId, user.id, "channel.archived", archived.id);
      return { archived: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), channelId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/servers/:serverId/categories", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!await serverMembership(params.serverId, user.id)) return respondError(set, 403, "not_a_server_member");
      const categories = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        select id, server_id, encrypted_metadata, position, created_at
        from categories
        where server_id = ${params.serverId} and archived_at is null
        order by position asc, created_at asc
      `;
      return {
        categories: categories.map((category) => ({
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        })),
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/servers/:serverId/categories", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "manage_categories")) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [position] = await db<{ next_position: number }[]>`
        select coalesce(max(position), -1) + 1 as next_position
        from categories where server_id = ${params.serverId} and archived_at is null
      `;
      const [category] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        insert into categories (server_id, created_by, encrypted_metadata, position)
        values (${params.serverId}, ${user.id}, ${metadata}, ${body.position ?? position.next_position})
        returning id, server_id, encrypted_metadata, position, created_at
      `;
      await recordServerAudit(params.serverId, user.id, "category.created", category.id);
      set.status = 201;
      return {
        category: {
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .patch("/v1/servers/:serverId/categories/:categoryId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "manage_categories")) return respondError(set, 403, "insufficient_server_permissions");

      const [existing] = await db<{ id: string }[]>`
        select id from categories
        where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
      `;
      if (!existing) return respondError(set, 404, "category_not_found");
      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined ? undefined : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }
      const [category] = await db<{
        id: string;
        server_id: string;
        encrypted_metadata: Buffer;
        position: number;
        created_at: Date;
      }[]>`
        update categories
        set encrypted_metadata = coalesce(${metadata ?? null}, encrypted_metadata),
            position = coalesce(${body.position ?? null}, position)
        where id = ${existing.id}
        returning id, server_id, encrypted_metadata, position, created_at
      `;
      await recordServerAudit(params.serverId, user.id, "category.updated", category.id);
      return {
        category: {
          id: category.id,
          serverId: category.server_id,
          encryptedMetadata: encodeBase64(category.encrypted_metadata),
          position: category.position,
          createdAt: category.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        position: t.Optional(t.Integer({ minimum: 0, maximum: 1_000_000 })),
      }),
    })
    .delete("/v1/servers/:serverId/categories/:categoryId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const membership = await serverAuthorization(params.serverId, user.id);
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasAnyServerPermission(membership, "manage_channels", "manage_categories")) return respondError(set, 403, "insufficient_server_permissions");
      const archived = await db.begin(async (transaction) => {
        const [category] = await transaction<{ id: string }[]>`
          update categories set archived_at = coalesce(archived_at, now())
          where id = ${params.categoryId} and server_id = ${params.serverId} and archived_at is null
          returning id
        `;
        if (!category) return false;
        await transaction`
          update channels set category_id = null
          where server_id = ${params.serverId} and category_id = ${params.categoryId}
        `;
        return true;
      });
      if (!archived) return respondError(set, 404, "category_not_found");
      await recordServerAudit(params.serverId, user.id, "category.archived", params.categoryId);
      return { archived: true };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }), categoryId: t.String({ format: "uuid" }) }),
    });
