import { expect, test } from "bun:test";
import { roleDropUpdates } from "./role-order";
const roles = [{ id: "owner", position: 100, isSystem: true }, { id: "a", position: 30, isSystem: false }, { id: "b", position: 20, isSystem: false }, { id: "c", position: 10, isSystem: false }];
test("role dragging preserves descending hierarchy slots and fixed system roles", () => {
  expect(roleDropUpdates(roles, "c", "a", false)).toEqual([{ id: "c", position: 30 }, { id: "a", position: 20 }, { id: "b", position: 10 }]);
  expect(roleDropUpdates(roles, "a", "c", true)).toEqual([{ id: "b", position: 30 }, { id: "c", position: 20 }, { id: "a", position: 10 }]);
});
test("role dragging never crosses the actor hierarchy ceiling or moves system roles", () => {
  expect(roleDropUpdates(roles, "c", "a", false, 30)).toEqual([]);
  expect(roleDropUpdates(roles, "owner", "a", false)).toEqual([]);
  expect(roleDropUpdates(roles, "a", "owner", false)).toEqual([]);
  expect(roleDropUpdates(roles, "b", "b", true)).toEqual([]);
});
test("tied hierarchy positions require manual correction before dragging", () => {
  expect(() => roleDropUpdates([{ ...roles[1], position: 20 }, roles[2]], "a", "b", true)).toThrow();
});
