import { expect, test } from "bun:test";
import { roomReferenceSlug, roomReferenceToken } from "./room-reference";

test("normalizes room names for # references", () => {
  expect(roomReferenceSlug("Project Alpha")).toBe("project-alpha");
  expect(roomReferenceSlug("!!!", "room-2")).toBe("room-2");
});

test("finds a room reference at the composer cursor", () => {
  expect(roomReferenceToken("open #pro")).toEqual({ query: "pro", start: 5, end: 9 });
  expect(roomReferenceToken("#")).toEqual({ query: "", start: 0, end: 1 });
  expect(roomReferenceToken("joined#project")).toBeNull();
});
