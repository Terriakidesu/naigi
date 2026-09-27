alter table server_roles drop constraint if exists server_roles_system_key;

update server_roles
set system_key = 'everyone'
where system_key = 'member';

update server_roles
set encrypted_metadata = decode('', 'base64')
where system_key in ('owner', 'everyone');

alter table server_roles
  add constraint server_roles_system_key check (
    (is_system and system_key in ('owner', 'admin', 'everyone'))
    or
    (not is_system and system_key is null)
  );

insert into server_member_roles (server_id, user_id, role_id)
select sm.server_id, sm.user_id, sr.id
from server_members sm
join server_roles sr
  on sr.server_id = sm.server_id
 and sr.system_key = 'everyone'
where sm.left_at is null
on conflict do nothing;

update server_roles
set permissions = permissions || case system_key
  when 'owner' then jsonb_build_object(
    'view_members', true,
    'create_channels', true,
    'edit_channels', true,
    'reorder_channels', true,
    'archive_channels', true,
    'manage_categories', true,
    'manage_channel_access', true,
    'view_invites', true,
    'create_invites', true,
    'revoke_invites', true,
    'manage_invite_limits', true,
    'create_roles', true,
    'edit_roles', true,
    'delete_roles', true,
    'assign_roles', true,
    'reorder_roles', true,
    'manage_role_permissions', true,
    'manage_role_appearance', true,
    'kick_members', true,
    'view_moderation_records', true,
    'unban_members', true,
    'remove_timeouts', true,
    'pin_messages', true,
    'delete_others_messages', true
  )
  when 'admin' then jsonb_build_object(
    'view_members', true,
    'create_channels', true,
    'edit_channels', true,
    'reorder_channels', true,
    'archive_channels', true,
    'manage_categories', true,
    'manage_channel_access', true,
    'view_invites', true,
    'create_invites', true,
    'revoke_invites', true,
    'manage_invite_limits', true,
    'create_roles', false,
    'edit_roles', false,
    'delete_roles', false,
    'assign_roles', false,
    'reorder_roles', false,
    'manage_role_permissions', false,
    'manage_role_appearance', false,
    'kick_members', true,
    'view_moderation_records', true,
    'unban_members', true,
    'remove_timeouts', true,
    'pin_messages', true,
    'delete_others_messages', true
  )
  when 'everyone' then jsonb_build_object(
    'view_members', true,
    'create_channels', false,
    'edit_channels', false,
    'reorder_channels', false,
    'archive_channels', false,
    'manage_categories', false,
    'manage_channel_access', false,
    'view_invites', false,
    'create_invites', false,
    'revoke_invites', false,
    'manage_invite_limits', false,
    'create_roles', false,
    'edit_roles', false,
    'delete_roles', false,
    'assign_roles', false,
    'reorder_roles', false,
    'manage_role_permissions', false,
    'manage_role_appearance', false,
    'kick_members', false,
    'view_moderation_records', false,
    'unban_members', false,
    'remove_timeouts', false,
    'pin_messages', true,
    'delete_others_messages', false
  )
  else jsonb_build_object(
    'view_members', false,
    'create_channels', false,
    'edit_channels', false,
    'reorder_channels', false,
    'archive_channels', false,
    'manage_categories', false,
    'manage_channel_access', false,
    'view_invites', false,
    'create_invites', false,
    'revoke_invites', false,
    'manage_invite_limits', false,
    'create_roles', false,
    'edit_roles', false,
    'delete_roles', false,
    'assign_roles', false,
    'reorder_roles', false,
    'manage_role_permissions', false,
    'manage_role_appearance', false,
    'kick_members', false,
    'view_moderation_records', false,
    'unban_members', false,
    'remove_timeouts', false,
    'pin_messages', false,
    'delete_others_messages', false
  )
end;
