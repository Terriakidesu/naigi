create table if not exists server_roles (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  encrypted_metadata bytea not null default decode('', 'base64'),
  color text not null default '#5865f2',
  position integer not null default 0,
  permissions jsonb not null default '{}'::jsonb,
  mentionable boolean not null default false,
  view_all_channels boolean not null default true,
  is_system boolean not null default false,
  system_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint server_roles_color check (color ~ '^#[0-9a-fA-F]{6}$'),
  constraint server_roles_position_nonnegative check (position >= 0),
  constraint server_roles_system_key check (
    (is_system and system_key in ('owner', 'admin', 'member'))
    or
    (not is_system and system_key is null)
  )
);

create unique index if not exists server_roles_system_key_idx
  on server_roles(server_id, system_key)
  where system_key is not null;
create index if not exists server_roles_server_position_idx
  on server_roles(server_id, position desc, created_at asc);

create table if not exists server_member_roles (
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role_id uuid not null references server_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (server_id, user_id, role_id)
);

create index if not exists server_member_roles_user_idx
  on server_member_roles(server_id, user_id, assigned_at);

create table if not exists server_role_channel_access (
  role_id uuid not null references server_roles(id) on delete cascade,
  channel_id uuid not null references channels(id) on delete cascade,
  can_view boolean not null default true,
  can_upload boolean not null default false,
  primary key (role_id, channel_id)
);

create index if not exists server_role_channel_access_channel_idx
  on server_role_channel_access(channel_id, role_id);

create table if not exists server_bans (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_by uuid not null references users(id),
  reason text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint server_bans_reason_length check (reason is null or char_length(reason) <= 240)
);

create unique index if not exists server_bans_active_idx
  on server_bans(server_id, user_id)
  where revoked_at is null;
create index if not exists server_bans_lookup_idx
  on server_bans(server_id, user_id, expires_at, revoked_at);

create table if not exists server_timeouts (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_by uuid not null references users(id),
  reason text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint server_timeouts_reason_length check (reason is null or char_length(reason) <= 240)
);

create unique index if not exists server_timeouts_active_idx
  on server_timeouts(server_id, user_id)
  where revoked_at is null;
create index if not exists server_timeouts_lookup_idx
  on server_timeouts(server_id, user_id, expires_at, revoked_at);

insert into server_roles (
  server_id, color, position, permissions, mentionable, view_all_channels, is_system, system_key
)
select
  s.id,
  '#f0b232',
  100000,
  jsonb_build_object(
    'view_channels', true,
    'send_messages', true,
    'upload_files', true,
    'mention_everyone', true,
    'mention_here', true,
    'mention_roles', true,
    'manage_server', true,
    'manage_channels', true,
    'manage_invites', true,
    'manage_roles', true,
    'manage_members', true,
    'ban_members', true,
    'timeout_members', true,
    'delete_messages', true
  ),
  false,
  true,
  true,
  'owner'
from servers s
on conflict do nothing;

insert into server_roles (
  server_id, color, position, permissions, mentionable, view_all_channels, is_system, system_key
)
select
  s.id,
  '#5865f2',
  90000,
  jsonb_build_object(
    'view_channels', true,
    'send_messages', true,
    'upload_files', true,
    'mention_everyone', true,
    'mention_here', true,
    'mention_roles', true,
    'manage_server', true,
    'manage_channels', true,
    'manage_invites', true,
    'manage_roles', false,
    'manage_members', true,
    'ban_members', true,
    'timeout_members', true,
    'delete_messages', true
  ),
  false,
  true,
  true,
  'admin'
from servers s
on conflict do nothing;

insert into server_roles (
  server_id, color, position, permissions, mentionable, view_all_channels, is_system, system_key
)
select
  s.id,
  '#99aab5',
  0,
  jsonb_build_object(
    'view_channels', true,
    'send_messages', true,
    'upload_files', true,
    'mention_everyone', false,
    'mention_here', false,
    'mention_roles', false,
    'manage_server', false,
    'manage_channels', false,
    'manage_invites', false,
    'manage_roles', false,
    'manage_members', false,
    'ban_members', false,
    'timeout_members', false,
    'delete_messages', false
  ),
  false,
  true,
  true,
  'member'
from servers s
on conflict do nothing;

insert into server_member_roles (server_id, user_id, role_id)
select sm.server_id, sm.user_id, sr.id
from server_members sm
join server_roles sr on sr.server_id = sm.server_id and sr.system_key = sm.role
where sm.left_at is null
on conflict do nothing;
