/**
 * The realtime WebSocket endpoint.
 *
 * A socket is a notification channel, not a transport for message content: it forwards encrypted
 * envelopes and presence that the browser then fetches authoritatively over HTTP. PostgreSQL stays
 * the source of truth, so a dropped socket costs a catch-up fetch rather than a lost message.
 */

import { Elysia, t } from "elysia";
import { config } from "../config";
import { authenticate } from "../auth/session";
import { upgradeOriginVerdict } from "../request-security";
import { voiceSignalAccessError } from "../voice/access";
import {
  closeRealtimeSocket,
  getRealtimeSocket,
  openRealtimeSocket,
} from "../realtime-registry";

/** Every command a client may send. Anything else closes the socket rather than being ignored. */
const realtimeCommand = t.Union([
  t.Object({
    type: t.Literal("subscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("unsubscribe"),
    conversationId: t.String({ format: "uuid" }),
  }),
  t.Object({
    type: t.Literal("typing"),
    conversationId: t.String({ format: "uuid" }),
    isTyping: t.Boolean(),
  }),
  t.Object({
    type: t.Literal("presence"),
    conversationId: t.String({ format: "uuid" }),
    state: t.Union([t.Literal("online"), t.Literal("idle"), t.Literal("offline")]),
  }),
  t.Object({
    type: t.Literal("voice.signal"),
    conversationId: t.String({ format: "uuid" }),
    // Encrypted signalling payload: the audio key never appears here, only ciphertext.
    ciphertext: t.String({ minLength: 1, maxLength: config.maxProtocolMetadataBytes }),
  }),
]);

/** Sends a control frame. Membership and block checks run inside the connection. */
function sendControl(socket: { send(data: string): number }, payload: object) {
  socket.send(JSON.stringify(payload));
}

export const realtimeSocketRoute = new Elysia().ws("/v1/realtime", {
  body: realtimeCommand,

  open: async (ws) => {
    const data = ws.data as { headers?: Record<string, string | undefined> };

    // `SameSite=Lax` already keeps the cookie off a cross-site handshake, so this is the second
    // layer: a handshake a browser identifies as cross-origin is refused before the session is
    // looked up.
    if (upgradeOriginVerdict(new Headers(data.headers as Record<string, string>)) === "reject") {
      ws.close(4003, "cross_origin_rejected");
      return;
    }

    const user = await authenticate(data.headers?.authorization, data.headers?.cookie);
    if (!user) {
      ws.close(4001, "unauthorized");
      return;
    }

    try {
      await openRealtimeSocket(ws.raw, user.id);
      ws.send(JSON.stringify({ type: "ready" }));
    } catch {
      // Redis or the database is unavailable. The client falls back to polling over HTTP, so this
      // is a degraded mode rather than a fatal one.
      ws.close(1013, "realtime_unavailable");
    }
  },

  message: async (ws, command) => {
    const active = getRealtimeSocket(ws.raw);
    if (!active) {
      ws.close(4001, "unauthorized");
      return;
    }
    const { connection, userId } = active;

    if (command.type === "subscribe") {
      // Membership is re-checked server-side; the client cannot subscribe to a room it is not in.
      const subscribed = await connection.subscribe(command.conversationId);
      if (!subscribed) sendControl(ws, { type: "error", error: "not_a_conversation_member" });
      return;
    }

    if (command.type === "unsubscribe") {
      await connection.unsubscribe(command.conversationId);
      return;
    }

    if (command.type === "typing") {
      const published = await connection.publish(command.conversationId, {
        type: "typing",
        conversationId: command.conversationId,
        isTyping: command.isTyping,
      });
      if (!published) sendControl(ws, { type: "error", error: "not_a_conversation_member" });
      return;
    }

    if (command.type === "presence") {
      const published = await connection.publish(command.conversationId, {
        type: "presence",
        conversationId: command.conversationId,
        state: command.state,
      });
      if (!published) sendControl(ws, { type: "error", error: "not_a_conversation_member" });
      return;
    }

    if (command.type === "voice.signal") {
      const accessError = await voiceSignalAccessError(command.conversationId, userId);
      if (accessError) {
        sendControl(ws, { type: "error", error: accessError, conversationId: command.conversationId });
        return;
      }
      const published = await connection.publish(command.conversationId, {
        type: "voice.signal",
        conversationId: command.conversationId,
        ciphertext: command.ciphertext,
      });
      if (!published) {
        sendControl(ws, { type: "error", error: "voice_signal_rejected", conversationId: command.conversationId });
      }
      return;
    }

    ws.close(1003, "unsupported_realtime_command");
  },

  close: async (ws) => {
    await closeRealtimeSocket(ws.raw);
  },
});
