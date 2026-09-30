export type RoomMessageReference = { channelId: string; messageId: string; name: string; kind: "text" | "voice"; href: string };

export function resolveRoomMessageLink(value: string, origin: string, serverId: string | undefined,
  rooms: ReadonlyArray<{ id: string; name: string; kind: "text" | "voice" }>): RoomMessageReference | undefined {
  if (!serverId) return;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password) return;
    const match = url.pathname.match(/^\/channels\/([^/]+)\/([^/]+)\/?$/);
    if (!match || decodeURIComponent(match[1]) !== serverId) return;
    const room = rooms.find((room) => room.id === decodeURIComponent(match[2]));
    const messageId = new URLSearchParams(url.hash.slice(1)).get("message");
    if (!room || !messageId || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(messageId)) return;
    return { channelId: room.id, messageId, name: room.name, kind: room.kind, href: url.href };
  } catch { return; }
}
