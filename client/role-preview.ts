import type { CustomServerRole, ServerChannel, ServerPermission, ServerPermissionMap } from "./api";

export type RolePreviewRole = Pick<CustomServerRole, "systemKey" | "viewAllChannels" | "channelAccess" | "categoryAccess"> & {
  permissions: Partial<ServerPermissionMap>;
};

export type RolePreviewChannel = Pick<ServerChannel, "id" | "categoryId">;

export function previewChannelCapabilities(role: RolePreviewRole, channel: RolePreviewChannel) {
  const channelAccess = role.channelAccess.find((access) => access.channelId === channel.id);
  const categoryAccess = channel.categoryId
    ? role.categoryAccess.find((access) => access.categoryId === channel.categoryId)
    : undefined;
  const isOwner = role.systemKey === "owner";
  const canView = isOwner || role.permissions.view_channels === true && (
    role.viewAllChannels
    || Boolean(channelAccess?.canView || channelAccess?.canUpload || categoryAccess?.canView || categoryAccess?.canUpload)
  );

  return {
    canView,
    canSend: isOwner || canView && role.permissions.send_messages === true,
    canUpload: isOwner || canView && role.permissions.upload_files === true && (
      role.viewAllChannels || Boolean(channelAccess?.canUpload || categoryAccess?.canUpload)
    ),
  };
}

export function previewRoleFeatures(role: Pick<RolePreviewRole, "systemKey" | "permissions">) {
  const has = (permission: ServerPermission) => role.systemKey === "owner" || role.permissions[permission] === true;
  const channelManagementPermissions: ServerPermission[] = [
    "manage_channels",
    "create_channels",
    "edit_channels",
    "reorder_channels",
    "archive_channels",
    "manage_categories",
    "manage_channel_access",
  ];
  const canManageChannels = channelManagementPermissions.some(has);
  const canManageInvites = has("manage_invites") || has("create_invites");
  const spaceManagementPermissions: ServerPermission[] = [
    "manage_server",
    "manage_channels",
    "create_channels",
    "edit_channels",
    "reorder_channels",
    "archive_channels",
    "manage_categories",
    "manage_roles",
    "create_roles",
    "edit_roles",
    "delete_roles",
    "reorder_roles",
    "manage_role_permissions",
    "manage_role_appearance",
    "manage_channel_access",
    "manage_invites",
    "create_invites",
    "assign_roles",
    "view_invites",
    "revoke_invites",
    "manage_invite_limits",
    "view_moderation_records",
    "manage_members",
    "kick_members",
    "ban_members",
    "unban_members",
    "timeout_members",
    "remove_timeouts",
    "warn_members",
    "revoke_warnings",
    "manage_custom_emoji",
    "view_audit_logs",
  ];
  const canManageSettings = spaceManagementPermissions.some(has);

  return {
    canViewMembers: has("view_members"),
    canManageChannels,
    canManageInvites,
    canManageSettings,
  };
}
