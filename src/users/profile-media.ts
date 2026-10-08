/**
 * Profile avatar and banner.
 *
 * These are server-managed profile media, not encrypted conversation attachments: the host can read
 * them, which `docs/SECURITY.md` states plainly. Reads are refused between blocked accounts, since
 * the media is not end-to-end encrypted and a block would otherwise be trivially bypassed.
 */

import { Elysia, t } from "elysia";
import { authenticate } from "../auth/session";
import { config } from "../config";
import { db } from "../db/client";
import { AttachmentTooLargeError } from "../attachments/storage";
import {
  ProfileImageInvalidError,
  profileImageMetadata,
  profileImagePath,
  removeProfileImage,
  storeProfileImage,
  validProfileImageBytes,
} from "../profile-images";
import { respondError } from "../http/responses";
import { toPublicUser, type UserRow } from "../http/shapes";
import { usersAreBlocked } from "../moderation/blocks";

export const profileMediaRoutes = new Elysia()
  .get("/v1/users/:userId/avatar", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      // A block is honoured here as it is for conversation content. Profile media is not
      // end-to-end encrypted, so a blocked party must not be able to keep fetching it by id.
      if (params.userId !== user.id && await usersAreBlocked(user.id, params.userId)) {
        return respondError(set, 403, "blocked_user");
      }
      const [profile] = await db<{ profile_image_storage_key: string | null; profile_image_mime_type: string | null }[]>`
        select profile_image_storage_key, profile_image_mime_type
        from users
        where id = ${params.userId}
      `;
      if (!profile?.profile_image_storage_key || !profile.profile_image_mime_type) {
        return respondError(set, 404, "profile_image_not_found");
      }
      const path = profileImagePath(profile.profile_image_storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "profile_image_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": profile.profile_image_mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .get("/v1/users/:userId/banner", async ({ headers, params, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (params.userId !== user.id && await usersAreBlocked(user.id, params.userId)) {
        return respondError(set, 403, "blocked_user");
      }
      const [profile] = await db<{ profile_banner_storage_key: string | null; profile_banner_mime_type: string | null }[]>`
        select profile_banner_storage_key, profile_banner_mime_type
        from users
        where id = ${params.userId}
      `;
      if (!profile?.profile_banner_storage_key || !profile.profile_banner_mime_type) {
        return respondError(set, 404, "profile_banner_not_found");
      }
      const path = profileImagePath(profile.profile_banner_storage_key);
      if (!(await Bun.file(path).exists())) return respondError(set, 404, "profile_banner_not_found");
      return new Response(Bun.file(path), {
        headers: {
          "cache-control": "private, max-age=3600",
          "content-type": profile.profile_banner_mime_type,
          "x-content-type-options": "nosniff",
        },
      });
    }, {
      params: t.Object({ userId: t.String({ format: "uuid" }) }),
    })
    .put("/v1/me/avatar", async ({ headers, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_profile_image_type");

      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "profile_image_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_profile_image");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = await db.begin(async (transaction) => {
          const [current] = await transaction<{ profile_image_storage_key: string | null }[]>`
            select profile_image_storage_key
            from users
            where id = ${user.id}
            for update
          `;
          if (!current) return null;
          const [next] = await transaction<UserRow[]>`
            update users
            set profile_image_storage_key = ${storageKey},
              profile_image_mime_type = ${metadata.mimeType},
              profile_image_size_bytes = ${stored.size}
            where id = ${user.id}
             returning id, username, display_name, created_at,
               profile_image_storage_key, profile_banner_storage_key
          `;
          previousStorageKey = current.profile_image_storage_key;
          return next;
        });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "user_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        return { user: toPublicUser(updated) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    })
    .delete("/v1/me/avatar", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const deleted = await db.begin(async (transaction) => {
        const [current] = await transaction<{ profile_image_storage_key: string | null }[]>`
          select profile_image_storage_key
          from users
          where id = ${user.id}
          for update
        `;
        if (!current) return null;
        await transaction`
          update users
          set profile_image_storage_key = null,
            profile_image_mime_type = null,
            profile_image_size_bytes = null
          where id = ${user.id}
        `;
        return current.profile_image_storage_key;
      });
      if (deleted) await removeProfileImage(deleted);
      return { deleted: Boolean(deleted) };
    })
    .put("/v1/me/banner", async ({ headers, request, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const metadata = profileImageMetadata(headers["content-type"]);
      if (!metadata) return respondError(set, 400, "unsupported_profile_banner_type");

      const storageKey = `${crypto.randomUUID()}.${metadata.extension}`;
      let stored: { size: number };
      try {
        stored = await storeProfileImage(
          request,
          storageKey,
          config.maxProfileImageBytes,
          (bytes) => validProfileImageBytes(bytes, metadata.mimeType),
        );
      } catch (error) {
        if (error instanceof AttachmentTooLargeError) return respondError(set, 413, "profile_banner_too_large");
        if (error instanceof ProfileImageInvalidError) return respondError(set, 400, "invalid_profile_banner");
        throw error;
      }

      let previousStorageKey: string | null = null;
      try {
        const updated = await db.begin(async (transaction) => {
          const [current] = await transaction<{ profile_banner_storage_key: string | null }[]>`
            select profile_banner_storage_key
            from users
            where id = ${user.id}
            for update
          `;
          if (!current) return null;
          const [next] = await transaction<UserRow[]>`
            update users
            set profile_banner_storage_key = ${storageKey},
              profile_banner_mime_type = ${metadata.mimeType},
              profile_banner_size_bytes = ${stored.size}
            where id = ${user.id}
            returning id, username, display_name, created_at,
              profile_image_storage_key, profile_banner_storage_key
          `;
          previousStorageKey = current.profile_banner_storage_key;
          return next;
        });
        if (!updated) {
          await removeProfileImage(storageKey);
          return respondError(set, 404, "user_not_found");
        }
        if (previousStorageKey && previousStorageKey !== storageKey) await removeProfileImage(previousStorageKey);
        return { user: toPublicUser(updated) };
      } catch (error) {
        await removeProfileImage(storageKey);
        throw error;
      }
    })
    .delete("/v1/me/banner", async ({ headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const deleted = await db.begin(async (transaction) => {
        const [current] = await transaction<{ profile_banner_storage_key: string | null }[]>`
          select profile_banner_storage_key
          from users
          where id = ${user.id}
          for update
        `;
        if (!current) return null;
        await transaction`
          update users
          set profile_banner_storage_key = null,
            profile_banner_mime_type = null,
            profile_banner_size_bytes = null
          where id = ${user.id}
        `;
        return current.profile_banner_storage_key;
      });
      if (deleted) await removeProfileImage(deleted);
      return { deleted: Boolean(deleted) };
    });
