export type AdminRole = "admin" | "moderator";
export type AdminCapability = "moderation" | "platform" | "evidenceKeys" | "operatorManagement";

export function adminCan(role: AdminRole, capability: AdminCapability) {
  return role === "admin" || capability === "moderation";
}
