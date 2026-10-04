/**
 * Live socket registry.
 *
 * A socket's presence is reported to the operations console, and an operator suspending an account
 * has to be able to close that account's sockets immediately. Both need the same view of who is
 * connected, so the registry lives here rather than inside the route that opens sockets.
 */

import {
  liveConnectionRefreshMs,
  refreshLiveConnections,
  registerLiveConnection,
  removeLiveConnection,
} from "./admin-operations/live-connections";
import { createRealtimeConnection, type RealtimeConnection } from "./realtime";

type RealtimeSocketHandle = {
  userId: string;
  connection: RealtimeConnection;
  close: () => void;
  operationsMember: string;
};

/** The minimal socket surface the registry needs, narrower than Elysia's WebSocket handle. */
type ClosableSocket = { close(code?: number, reason?: string): void };

const connections = new Map<ClosableSocket, RealtimeSocketHandle>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Keeps the operations lease fresh while at least one socket is open.
 *
 * Leases expire on their own if Redis becomes unavailable, so a failed refresh is ignored rather
 * than propagated.
 */
function ensureLiveConnectionRefresh() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    const members = [...connections.values()].map((active) => active.operationsMember);
    void refreshLiveConnections(members).catch(() => {});
  }, liveConnectionRefreshMs);
}

function stopLiveConnectionRefreshIfIdle() {
  if (connections.size > 0 || !refreshTimer) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

export async function openRealtimeSocket(
  socket: Parameters<typeof createRealtimeConnection>[0],
  userId: string,
) {
  const connection = await createRealtimeConnection(socket, userId);
  const operationsMember = await registerLiveConnection(userId);
  connections.set(socket, {
    userId,
    connection,
    close: () => socket.close(4003, "account_suspended"),
    operationsMember,
  });
  ensureLiveConnectionRefresh();
  return operationsMember;
}

export function getRealtimeSocket(socket: ClosableSocket) {
  return connections.get(socket);
}

export async function closeRealtimeSocket(socket: ClosableSocket) {
  const active = connections.get(socket);
  connections.delete(socket);
  if (active) {
    await removeLiveConnection(active.operationsMember).catch(() => undefined);
    await active.connection.close();
  }
  stopLiveConnectionRefreshIfIdle();
}

/** Closes every socket belonging to an account. Used when an operator suspends a user. */
export function closeSocketsForUser(userId: string) {
  for (const active of connections.values()) {
    if (active.userId === userId) active.close();
  }
}

export function realtimeSocketCount() {
  return connections.size;
}
