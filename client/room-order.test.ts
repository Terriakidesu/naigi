import { expect, test } from "bun:test";
import { roomDropUpdates } from "./room-order";

const rooms = [{ id: "a", categoryId: null, position: 0 }, { id: "b", categoryId: "team", position: 0 }, { id: "c", categoryId: "team", position: 1 }];
test("room drop moves into a category and preserves other rooms", () => {
  expect(roomDropUpdates(rooms, "a", "team", "c")).toEqual([{ id: "a", categoryId: "team", position: 1 }, { id: "c", position: 2 }]);
  expect(rooms[0].categoryId).toBeNull();
});
test("room drop can reorder, append, or remove a category", () => {
  expect(roomDropUpdates(rooms, "c", "team", "b")).toEqual([{ id: "c", position: 0 }, { id: "b", position: 1 }]);
  expect(roomDropUpdates(rooms, "a", "team")).toEqual([{ id: "a", position: 2, categoryId: "team" }]);
  expect(roomDropUpdates(rooms, "b", null)).toEqual([{ id: "b", position: 1, categoryId: null }]);
});
test("invalid and self drops do not change order", () => {
  expect(roomDropUpdates(rooms, "missing", "team")).toEqual([]);
  expect(roomDropUpdates(rooms, "b", "team", "b")).toEqual([]);
  expect(roomDropUpdates(rooms, "b", null, "c")).toEqual([]);
});
