/**
 * LiveKit token issuance.
 *
 * The browser encrypts audio before it reaches the relay, so the media key never passes through
 * here; the server only mints a short-lived, least-privilege token. The API secret is used to derive
 * an opaque room name and a stable per-account participant identity, and is never returned.
 */

import { Elysia, t } from "elysia";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { authenticate } from "../auth/session";
import { config } from "../config";
import { evalRedisScript } from "../redis/client";
import { respondError } from "../http/responses";
import { claimVoiceRoomDevice, VoiceRoomDeviceConflict, voiceRoomIdentity } from "../voice-room-device";
import { directVoiceCallAccessError, voiceRoomAccessError } from "./access";

/**
 * LiveKit room administration client.
 *
 * Created lazily and reused, so a burst of calls does not open a connection per token. Returns
 * `undefined` when no voice service is configured, which every caller treats as "not configured".
 */
let roomService: RoomServiceClient | undefined;

function liveKitRoomService() {
  if (!config.liveKit) return undefined;
  roomService ??= new RoomServiceClient(
    config.liveKit.httpUrl,
    config.liveKit.apiKey,
    config.liveKit.apiSecret,
  );
  return roomService;
}

/**
 * Token issuance budget: 12 per user per minute, charged against a Redis counter.
 *
 * Fails closed, because a limiter that cannot be reached must not become an unthrottled way to mint
 * signed relay credentials.
 */
async function voiceTokenRateLimited(userId: string) {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `naigi:voice-token:${userId}:${minute}`;
  const count = Number(await evalRedisScript(
    "local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count",
    1,
    key,
    120,
  ));
  return count > 12;
}

export const voiceRoutes = new Elysia()
  .post("/v1/voice/token", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const accessError = await directVoiceCallAccessError(body.conversationId, user.id);
      if (accessError) return respondError(set, 403, accessError);
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      try {
        if (await voiceTokenRateLimited(user.id)) return respondError(set, 429, "voice_token_rate_limited");
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }

      const roomDigest = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${body.conversationId}:${body.callId}`),
      )).toString("base64url");
      const roomName = `naigi-voice-${roomDigest}`;
      const roomService = liveKitRoomService();
      if (!roomService) return respondError(set, 503, "voice_service_not_configured");
      try {
        await roomService.createRoom({ name: roomName, emptyTimeout: 45, departureTimeout: 30, maxParticipants: 2 });
      } catch (error) {
        const existingRooms = await roomService.listRooms([roomName]).catch(() => []);
        if (!existingRooms.some((room) => room.name === roomName)) throw error;
      }

      const accessToken = new AccessToken(config.liveKit.apiKey, config.liveKit.apiSecret, {
        identity: crypto.randomUUID(),
        ttl: "10m",
      });
      accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: true,
        canPublishData: false,
      });
      set.headers["cache-control"] = "no-store";
      return { url: config.liveKit.webSocketUrl, token: await accessToken.toJwt() };
    }, {
      body: t.Object({
        conversationId: t.String({ format: "uuid" }),
        callId: t.String({ format: "uuid" }),
      }),
    })
    .post("/v1/voice/check", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const accessError = await directVoiceCallAccessError(body.conversationId, user.id);
      if (accessError) return respondError(set, 403, accessError);
      set.headers["cache-control"] = "no-store";
      return { authorized: true };
    }, {
      body: t.Object({
        conversationId: t.String({ format: "uuid" }),
        callId: t.String({ format: "uuid" }),
      }),
    })
    .post("/v1/voice/room-token", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const access = await voiceRoomAccessError(body.channelId, user.id);
      if ("error" in access) return respondError(set, 403, access.error ?? "voice_room_not_found");
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      try {
        if (await voiceTokenRateLimited(user.id)) return respondError(set, 429, "voice_token_rate_limited");
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }

      const roomDigest = Buffer.from(await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`naigi-voice-channel:${access.channel.id}`),
      )).toString("base64url");
      const roomName = `naigi-voice-room-${roomDigest}`;
      const roomService = liveKitRoomService();
      if (!roomService) return respondError(set, 503, "voice_service_not_configured");
      let failureStage = "list_room";
      try {
        let rooms = await roomService.listRooms([roomName]);
        if (!rooms.some((room) => room.name === roomName)) {
          failureStage = "create_room";
          try {
            // Do not impose an application-wide participant count. LiveKit and
            // the host's deployment resources determine how many can join.
            await roomService.createRoom({ name: roomName, emptyTimeout: 60, departureTimeout: 30 });
          } catch {
            failureStage = "confirm_room_creation";
            rooms = await roomService.listRooms([roomName]);
            if (!rooms.some((room) => room.name === roomName)) throw new Error("voice_room_creation_failed");
          }
          failureStage = "verify_room";
          rooms = await roomService.listRooms([roomName]);
        }
        failureStage = "claim_device";
        const identity = voiceRoomIdentity(access.channel.id, user.id, config.liveKit.apiSecret);
        await claimVoiceRoomDevice(identity, body.instanceId ?? crypto.randomUUID(), body.replaceExisting === true,
          await roomService.listParticipants(roomName),
          async (participantIdentity, instanceId, replaceExisting) => Number(await evalRedisScript(
            "local owner = redis.call('GET', KEYS[1]); if owner and owner ~= ARGV[1] and ARGV[2] ~= '1' then return 0; end; redis.call('SET', KEYS[1], ARGV[1], 'EX', 60); return 1",
            1, `naigi:voice-room-device:${participantIdentity}`, instanceId, replaceExisting ? "1" : "0",
          )) === 1);
        const activeParticipants = rooms.find((room) => room.name === roomName)?.numParticipants ?? 0;
        const bootstrapKey = `naigi:voice-room-bootstrap:${access.channel.id}`;
        let canStart = false;
        failureStage = "bootstrap_lock";
        if (activeParticipants > 0) {
          await evalRedisScript("return redis.call('DEL', KEYS[1])", 1, bootstrapKey);
        } else {
          const acquired = await evalRedisScript(
            "if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); return 1; end; return 0",
            1,
            bootstrapKey,
            crypto.randomUUID(),
            30,
          );
          canStart = Number(acquired) === 1;
        }

        failureStage = "sign_token";
        const accessToken = new AccessToken(config.liveKit.apiKey, config.liveKit.apiSecret, {
          identity,
          ttl: "10m",
        });
        accessToken.addGrant({
          roomJoin: true,
          room: roomName,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: false,
        });
        set.headers["cache-control"] = "no-store";
        return { url: config.liveKit.webSocketUrl, token: await accessToken.toJwt(), canStart };
      } catch (error) {
        if (error instanceof VoiceRoomDeviceConflict) return respondError(set, 409, "voice_room_active_on_another_device");
        const errorType = error instanceof Error ? error.name : typeof error;
        console.error(`[voice-room] room token failed at ${failureStage} (${errorType})`);
        return respondError(set, 503, "voice_room_service_unavailable");
      }
    }, {
      body: t.Object({
        channelId: t.String({ format: "uuid" }),
        instanceId: t.Optional(t.String({ format: "uuid" })),
        replaceExisting: t.Optional(t.Boolean()),
      }),
    })
    .post("/v1/voice/room-release", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      if (!config.liveKit) return respondError(set, 503, "voice_service_not_configured");
      const identity = voiceRoomIdentity(body.channelId, user.id, config.liveKit.apiSecret);
      try {
        const released = await evalRedisScript(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]); end; return 0",
          1, `naigi:voice-room-device:${identity}`, body.instanceId,
        );
        set.headers["cache-control"] = "no-store";
        return { released: Number(released) === 1 };
      } catch {
        return respondError(set, 503, "voice_token_service_unavailable");
      }
    }, {
      body: t.Object({ channelId: t.String({ format: "uuid" }), instanceId: t.String({ format: "uuid" }) }),
    })
    .post("/v1/voice/room-check", async ({ body, headers, set }) => {
      const user = await authenticate(headers.authorization, headers.cookie);
      if (!user) return respondError(set, 401, "unauthorized");
      const access = await voiceRoomAccessError(body.channelId, user.id);
      if ("error" in access) return respondError(set, 403, access.error ?? "voice_room_not_found");
      set.headers["cache-control"] = "no-store";
      return { authorized: true };
    }, {
      body: t.Object({ channelId: t.String({ format: "uuid" }) }),
    });
