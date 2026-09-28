alter table servers
  add column if not exists icon_storage_key text,
  add column if not exists icon_mime_type text,
  add column if not exists icon_size_bytes bigint,
  add column if not exists banner_storage_key text,
  add column if not exists banner_mime_type text,
  add column if not exists banner_size_bytes bigint;

create unique index if not exists servers_icon_storage_key_idx
  on servers(icon_storage_key)
  where icon_storage_key is not null;

create unique index if not exists servers_banner_storage_key_idx
  on servers(banner_storage_key)
  where banner_storage_key is not null;

create table if not exists server_custom_emojis (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  created_by uuid not null references users(id),
  encrypted_metadata bytea not null default decode('', 'base64'),
  storage_key text not null unique,
  expected_size_bytes bigint not null,
  size_bytes bigint,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  constraint server_custom_emojis_status check (status in ('pending', 'uploaded')),
  constraint server_custom_emojis_expected_size check (expected_size_bytes between 1 and 10485760),
  constraint server_custom_emojis_size check (size_bytes is null or size_bytes between 1 and 10485760)
);

create index if not exists server_custom_emojis_server_idx
  on server_custom_emojis(server_id, created_at desc);

create table if not exists server_audit_logs (
  id bigint generated always as identity primary key,
  server_id uuid not null references servers(id) on delete cascade,
  actor_id uuid not null references users(id),
  action text not null,
  target_id uuid,
  target_user_id uuid references users(id),
  created_at timestamptz not null default now(),
  constraint server_audit_logs_action_length check (char_length(action) between 1 and 80)
);

create index if not exists server_audit_logs_server_created_idx
  on server_audit_logs(server_id, created_at desc, id desc);

update server_roles
set permissions = permissions || jsonb_build_object(
  'manage_custom_emoji', case when system_key in ('owner', 'admin') then true else false end,
  'view_audit_logs', case when system_key in ('owner', 'admin') then true else false end
)
where is_system;
