import { describe, expect, test } from "bun:test";
import { highestSeparatedRole } from "./member-roles";

describe("separated member role grouping", () => {
  const roles = [
    { id: "owner", position: 100, separateMembers: true },
    { id: "lead", position: 80, separateMembers: false },
    { id: "moderator", position: 50, separateMembers: true },
    { id: "member", position: 0, separateMembers: false },
  ];

  test("uses the highest-priority assigned role that is marked separate", () => {
    expect(highestSeparatedRole(["lead", "moderator", "member"], roles)?.id).toBe("moderator");
    expect(highestSeparatedRole(["owner", "moderator"], roles)?.id).toBe("owner");
  });

  test("returns no group role when none of the assigned roles are separated", () => {
    expect(highestSeparatedRole(["lead", "member"], roles)).toBeUndefined();
    expect(highestSeparatedRole([], roles)).toBeUndefined();
  });
});
