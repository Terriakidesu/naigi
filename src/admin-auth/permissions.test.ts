import { expect, test } from "bun:test";
import { adminCan } from "./permissions";

test("admin role capabilities", () => {
  for (const capability of ["moderation", "platform", "evidenceKeys", "operatorManagement"] as const) {
    expect(adminCan("admin", capability)).toBe(true);
  }
  expect(adminCan("moderator", "moderation")).toBe(true);
  for (const capability of ["platform", "evidenceKeys", "operatorManagement"] as const) {
    expect(adminCan("moderator", capability)).toBe(false);
  }
});
