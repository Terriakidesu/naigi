/**
 * Space lifecycle.
 *
 * A space is created with its three system roles, which is what makes the per-role permission model
 * work from the first message. Every read and write re-derives the caller's authorization rather
 * than trusting anything the client sends about its own access.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { db } from "../db/client";
import { decodeBase64, encodeBase64, InvalidEncodingError } from "../encoding";
import { recordServerAudit } from "../http/audit";
import { respondError } from "../http/responses";
import { serverBrandingUrl } from "../http/shapes";
import { decodeEncryptedMetadata } from "../http/validation";
import { syncServerChannelMemberships } from "./membership";
import {
  defaultRolePermissions,
  hasServerPermission,
  permissionMap,
  serverAuthorization,
} from "./permissions";
import { visibleServerChannels } from "./channel-access";

export const serverRoutes = new Elysia()
  .post("/v1/servers", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      let metadata: Buffer;
      try {
        metadata = decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      const created = await db.begin(async (transaction) => {
        const [server] = await transaction<{ id: string; owner_id: string; created_at: Date }[]>`
          insert into servers (owner_id, encrypted_metadata)
          values (${user.id}, ${metadata})
          returning id, owner_id, created_at
        `;
        const systemRoles = [
          { systemKey: "owner", color: "#f0b232", position: 100_000, separateMembers: true, permissions: defaultRolePermissions("owner") },
          { systemKey: "admin", color: "#92aaa5", position: 90_000, separateMembers: true, permissions: defaultRolePermissions("admin") },
          { systemKey: "everyone", color: "#99aab5", position: 0, separateMembers: false, permissions: defaultRolePermissions("everyone") },
        ] as const;
        for (const systemRole of systemRoles) {
          await transaction`
            insert into server_roles (
              server_id, color, position, permissions, mentionable, separate_members, view_all_channels, is_system, system_key
            ) values (
              ${server.id}, ${systemRole.color}, ${systemRole.position}, ${systemRole.permissions}::jsonb,
              false, ${systemRole.separateMembers}, true, true, ${systemRole.systemKey}
            )
          `;
        }
        await transaction`
          insert into server_members (server_id, user_id, role)
          values (${server.id}, ${user.id}, 'owner')
        `;
        await transaction`
          insert into server_member_roles (server_id, user_id, role_id)
          select ${server.id}, ${user.id}, id
          from server_roles
          where server_id = ${server.id} and system_key in ('owner', 'everyone')
        `;
        const [conversation] = await transaction<{ id: string }[]>`
          insert into conversations (kind, created_by)
          values ('channel', ${user.id})
          returning id
        `;
        await transaction`
          insert into conversation_members (conversation_id, user_id, role)
          values (${conversation.id}, ${user.id}, 'owner')
        `;
        const [channel] = await transaction<{ id: string; position: number; created_at: Date }[]>`
          insert into channels (server_id, conversation_id, created_by, position)
          values (${server.id}, ${conversation.id}, ${user.id}, 0)
          returning id, position, created_at
        `;
        await transaction`
          update servers
          set onboarding_channel_id = ${channel.id}, landing_channel_id = ${channel.id}
          where id = ${server.id}
        `;
        return { server, channel, conversationId: conversation.id };
      });
      await recordServerAudit(created.server.id, user.id, "server.created", created.server.id);

      set.status = 201;
      return {
        server: {
          id: created.server.id,
          ownerId: created.server.owner_id,
          encryptedMetadata: encodeBase64(metadata),
          role: "owner",
          permissions: defaultRolePermissions("owner"),
          channelCount: 1,
          onboardingChannelId: created.channel.id,
          landingChannelId: created.channel.id,
          iconUrl: null,
          bannerUrl: null,
          deactivatedAt: null,
          createdAt: created.server.created_at,
        },
        channel: {
          id: created.channel.id,
          serverId: created.server.id,
          conversationId: created.conversationId,
          encryptedMetadata: "",
          categoryId: null,
          kind: "text",
          position: created.channel.position,
          createdAt: created.channel.created_at,
        },
      };
    }, {
      body: t.Object({ encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })) }),
    })
    .get("/v1/servers", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");

      const servers = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        onboarding_channel_id: string | null;
        landing_channel_id: string | null;
        icon_storage_key: string | null;
        banner_storage_key: string | null;
        deactivated_at: Date | null;
        created_at: Date;
      }[]>`
        select s.id, s.owner_id, s.encrypted_metadata, sm.role,
          count(c.id)::int as channel_count, s.onboarding_channel_id,
          s.landing_channel_id, s.deactivated_at,
          s.icon_storage_key, s.banner_storage_key, s.created_at
        from servers s
        join server_members sm on sm.server_id = s.id
        left join channels c on c.server_id = s.id and c.archived_at is null
        where sm.user_id = ${user.id} and sm.left_at is null
          group by s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
            s.onboarding_channel_id, s.landing_channel_id, s.deactivated_at,
            s.icon_storage_key, s.banner_storage_key
        order by s.created_at asc
      `;

      return {
        servers: await Promise.all(servers.map(async (server) => ({
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          permissions: server.deactivated_at
            ? permissionMap(undefined)
            : (await serverAuthorization(server.id, user.id))?.permissions ?? permissionMap(undefined),
          channelCount: server.channel_count,
          onboardingChannelId: server.onboarding_channel_id,
          landingChannelId: server.landing_channel_id,
          iconUrl: server.deactivated_at ? null : serverBrandingUrl(server.id, "icon", server.icon_storage_key),
          bannerUrl: server.deactivated_at ? null : serverBrandingUrl(server.id, "banner", server.banner_storage_key),
          deactivatedAt: server.deactivated_at,
          createdAt: server.created_at,
        }))),
      };
    })
    .get("/v1/servers/:serverId", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const [server] = await db<{
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        onboarding_channel_id: string | null;
        landing_channel_id: string | null;
        icon_storage_key: string | null;
        banner_storage_key: string | null;
        created_at: Date;
      }[]>`
         select s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
           s.onboarding_channel_id, s.landing_channel_id,
           s.icon_storage_key, s.banner_storage_key,
           count(c.id)::int as channel_count
        from servers s
        join server_members sm on sm.server_id = s.id
        left join channels c on c.server_id = s.id and c.archived_at is null
         where s.id = ${params.serverId} and sm.user_id = ${user.id} and sm.left_at is null
           and s.deactivated_at is null
         group by s.id, s.owner_id, s.encrypted_metadata, sm.role, s.created_at,
            s.onboarding_channel_id, s.landing_channel_id,
            s.icon_storage_key, s.banner_storage_key
      `;
      if (!server) return respondError(set, 404, "server_not_found");
      const authorization = await serverAuthorization(params.serverId, user.id);
      return {
        server: {
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          permissions: authorization?.permissions ?? permissionMap(undefined),
          channelCount: server.channel_count,
          onboardingChannelId: server.onboarding_channel_id,
          landingChannelId: server.landing_channel_id,
          iconUrl: serverBrandingUrl(server.id, "icon", server.icon_storage_key),
          bannerUrl: serverBrandingUrl(server.id, "banner", server.banner_storage_key),
          deactivatedAt: null,
          createdAt: server.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
    })
    .patch("/v1/servers/:serverId", async ({ body, headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const authorization = await serverAuthorization(params.serverId, user.id);
      const membership = authorization;
      if (!membership) return respondError(set, 403, "not_a_server_member");
      if (!hasServerPermission(membership, "manage_server")) return respondError(set, 403, "insufficient_server_permissions");

      let metadata: Buffer | undefined;
      try {
        metadata = body.encryptedMetadata === undefined ? undefined : decodeEncryptedMetadata(body.encryptedMetadata);
      } catch (error) {
        if (error instanceof InvalidEncodingError) return respondError(set, 400, "invalid_encrypted_metadata");
        throw error;
      }

      if (body.onboardingChannelId || body.landingChannelId) {
        const requestedChannels = [body.onboardingChannelId, body.landingChannelId].filter(
          (channelId): channelId is string => typeof channelId === "string",
        );
        const channels = await db<{ id: string }[]>`
          select id from channels
          where id in ${db(requestedChannels)}
            and server_id = ${params.serverId} and archived_at is null
        `;
        if (body.onboardingChannelId && !channels.some((channel) => channel.id === body.onboardingChannelId)) {
          return respondError(set, 404, "onboarding_channel_not_found");
        }
        if (body.landingChannelId && !channels.some((channel) => channel.id === body.landingChannelId)) {
          return respondError(set, 404, "landing_channel_not_found");
        }
      }

      type ServerUpdateRow = {
        id: string;
        owner_id: string;
        encrypted_metadata: Buffer;
        role: "owner" | "admin" | "member";
        channel_count: number;
        onboarding_channel_id: string | null;
        landing_channel_id: string | null;
        icon_storage_key: string | null;
        banner_storage_key: string | null;
        created_at: Date;
      };
      const onboardingChannel = body.onboardingChannelId === undefined
        ? db`s.onboarding_channel_id`
        : db`${body.onboardingChannelId}`;
      const landingChannel = body.landingChannelId === undefined
        ? db`s.landing_channel_id`
        : db`${body.landingChannelId}`;
      const [server] = await db<ServerUpdateRow[]>`
        update servers s
        set encrypted_metadata = coalesce(${metadata ?? null}, s.encrypted_metadata),
            onboarding_channel_id = ${onboardingChannel},
            landing_channel_id = ${landingChannel},
            updated_at = now()
        where s.id = ${params.serverId}
        returning s.id, s.owner_id, s.encrypted_metadata, s.onboarding_channel_id,
          s.landing_channel_id,
          s.icon_storage_key, s.banner_storage_key,
          (select role from server_members where server_id = s.id and user_id = ${user.id} and left_at is null) as role,
          (select count(*)::int from channels where server_id = s.id and archived_at is null) as channel_count,
          s.created_at
      `;
      if (!server) return respondError(set, 404, "server_not_found");
      await recordServerAudit(params.serverId, user.id, "server.settings_updated", params.serverId);
      return {
        server: {
          id: server.id,
          ownerId: server.owner_id,
          encryptedMetadata: encodeBase64(server.encrypted_metadata),
          role: server.role,
          permissions: membership.permissions,
          channelCount: server.channel_count,
          onboardingChannelId: server.onboarding_channel_id,
          landingChannelId: server.landing_channel_id,
          iconUrl: serverBrandingUrl(server.id, "icon", server.icon_storage_key),
          bannerUrl: serverBrandingUrl(server.id, "banner", server.banner_storage_key),
          deactivatedAt: null,
          createdAt: server.created_at,
        },
      };
    }, {
      params: t.Object({ serverId: t.String({ format: "uuid" }) }),
      body: t.Object({
        encryptedMetadata: t.Optional(t.String({ maxLength: 90_000 })),
        onboardingChannelId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
        landingChannelId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
      }),
    });
