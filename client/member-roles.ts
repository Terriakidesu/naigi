import type { CustomServerRole } from "./api";

type MemberDisplayRole = Pick<CustomServerRole, "id" | "position" | "separateMembers">;

export function highestSeparatedRole<T extends MemberDisplayRole>(roleIds: readonly string[], roles: readonly T[]): T | undefined {
  const assignedRoleIds = new Set(roleIds);
  let highest: T | undefined;
  for (const role of roles) {
    if (!role.separateMembers || !assignedRoleIds.has(role.id)) continue;
    if (!highest || role.position > highest.position) highest = role;
  }
  return highest;
}
