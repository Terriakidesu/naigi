import { expect, test } from "bun:test";
import { resolveRoomMessageLink } from "./room-message-link";
const origin = "https://naigi.local";
const server = "11111111-1111-4111-8111-111111111111";
const room = "22222222-2222-4222-8222-222222222222";
const message = "33333333-3333-4333-8333-333333333333";
const rooms = [{ id: room, name: "general", kind: "text" as const }];
const link = `${origin}/channels/${server}/${room}#message=${message}`;
test("same-space message links resolve to local room labels with the jump preserved", () => {
  expect(resolveRoomMessageLink(link, origin, server, rooms)).toEqual({ channelId: room, messageId: message, name: "general", kind: "text", href: link });
});
test("foreign spaces, hosts, inaccessible rooms, and malformed message links remain ordinary links", () => {
  expect(resolveRoomMessageLink(link, origin, "other", rooms)).toBeUndefined();
  expect(resolveRoomMessageLink(link.replace(origin, "https://elsewhere.test"), origin, server, rooms)).toBeUndefined();
  expect(resolveRoomMessageLink(link, origin, server, [])).toBeUndefined();
  expect(resolveRoomMessageLink(link.replace(message, "invalid"), origin, server, rooms)).toBeUndefined();
  expect(resolveRoomMessageLink(link.split("#")[0], origin, server, rooms)).toBeUndefined();
  expect(resolveRoomMessageLink(link.replace("https://", "https://user:password@"), origin, server, rooms)).toBeUndefined();
});
