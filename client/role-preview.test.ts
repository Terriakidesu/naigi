import { describe, expect, test } from "bun:test";
import { previewChannelCapabilities, previewRoleFeatures, type RolePreviewRole } from "./role-preview";

function role(overrides: Partial<RolePreviewRole> = {}): RolePreviewRole {
  return {
    systemKey: "member",
    permissions: {},
    viewAllChannels: false,
    channelAccess: [],
    categoryAccess: [],
    ...overrides,
  };
}

describe("whole-space role preview", () => {
  test("hides rooms unless the role grants view access to that room or its category", () => {
    const candidate = role({
      permissions: { view_channels: true, send_messages: true, upload_files: true },
    });

    expect(previewChannelCapabilities(candidate, { id: "room-1", categoryId: null })).toEqual({
      canView: false,
      canSend: false,
      canUpload: false,
    });
  });

  test("requires the role-wide view permission even when a room override allows access", () => {
    const candidate = role({
      permissions: { send_messages: true, upload_files: true },
      channelAccess: [{ channelId: "room-1", canView: true, canUpload: true }],
    });

    expect(previewChannelCapabilities(candidate, { id: "room-1", categoryId: null })).toEqual({
      canView: false,
      canSend: false,
      canUpload: false,
    });
  });

  test("inherits category visibility and upload access while respecting role-wide upload permission", () => {
    const candidate = role({
      permissions: { view_channels: true, send_messages: true, upload_files: true },
      categoryAccess: [{ categoryId: "group-1", canView: false, canUpload: true }],
    });

    expect(previewChannelCapabilities(candidate, { id: "room-1", categoryId: "group-1" })).toEqual({
      canView: true,
      canSend: true,
      canUpload: true,
    });
    expect(previewChannelCapabilities(role({
      ...candidate,
      permissions: { ...candidate.permissions, upload_files: false },
    }), { id: "room-1", categoryId: "group-1" }).canUpload).toBe(false);
  });

  test("view-all grants room visibility but does not grant message or upload permissions", () => {
    const candidate = role({
      permissions: { view_channels: true, send_messages: true },
      viewAllChannels: true,
    });

    expect(previewChannelCapabilities(candidate, { id: "room-1", categoryId: null })).toEqual({
      canView: true,
      canSend: true,
      canUpload: false,
    });
  });

  test("the owner role keeps its server-side permission bypass", () => {
    expect(previewChannelCapabilities(role({ systemKey: "owner" }), { id: "room-1", categoryId: null })).toEqual({
      canView: true,
      canSend: true,
      canUpload: true,
    });
  });

  test("shows people and management controls only when that role permits them", () => {
    expect(previewRoleFeatures(role({
      permissions: { view_members: true, create_channels: true, create_invites: true },
    }))).toEqual({
      canViewMembers: true,
      canManageChannels: true,
      canManageInvites: true,
      canManageSettings: true,
    });
    expect(previewRoleFeatures(role())).toEqual({
      canViewMembers: false,
      canManageChannels: false,
      canManageInvites: false,
      canManageSettings: false,
    });
  });
});
