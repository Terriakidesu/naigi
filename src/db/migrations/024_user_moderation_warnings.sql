alter table instance_user_suspensions
  add column reason text;

alter table instance_user_suspensions
  add constraint instance_user_suspensions_reason_length
  check (reason is null or char_length(reason) <= 240);

create table if not exists instance_user_warnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  created_by uuid not null,
  created_by_username text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  acknowledged_at timestamptz,
  revoked_at timestamptz,
  constraint instance_user_warnings_reason_length check (char_length(reason) between 1 and 240)
);

create index if not exists instance_user_warnings_user_history_idx
  on instance_user_warnings(user_id, created_at desc);
create index if not exists instance_user_warnings_active_user_idx
  on instance_user_warnings(user_id, expires_at)
  where revoked_at is null;

create table if not exists server_member_warnings (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_by uuid not null references users(id),
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  acknowledged_at timestamptz,
  revoked_at timestamptz,
  constraint server_member_warnings_reason_length check (char_length(reason) between 1 and 240)
);

create index if not exists server_member_warnings_user_history_idx
  on server_member_warnings(server_id, user_id, created_at desc);
create index if not exists server_member_warnings_user_pending_idx
  on server_member_warnings(user_id, created_at desc)
  where acknowledged_at is null and revoked_at is null;
create index if not exists server_member_warnings_server_history_idx
  on server_member_warnings(server_id, created_at desc);
create index if not exists server_member_warnings_active_server_idx
  on server_member_warnings(server_id, expires_at)
  where revoked_at is null;

update server_roles
set permissions = jsonb_set(
  jsonb_set(
    coalesce(permissions, '{}'::jsonb),
    '{warn_members}',
    to_jsonb(coalesce(system_key in ('owner', 'admin'), false)),
    true
  ),
  '{revoke_warnings}',
  to_jsonb(coalesce(system_key in ('owner', 'admin'), false)),
  true
);
