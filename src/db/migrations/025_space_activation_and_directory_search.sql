alter table servers
  add column deactivated_at timestamptz;

create index if not exists servers_created_id_idx
  on servers(created_at desc, id desc);

create index if not exists servers_active_created_id_idx
  on servers(created_at desc, id desc)
  where deactivated_at is null;

create index if not exists servers_deactivated_created_id_idx
  on servers(created_at desc, id desc)
  where deactivated_at is not null;

create table if not exists instance_server_audit_logs (
  id bigint generated always as identity primary key,
  server_id uuid not null references servers(id) on delete cascade,
  admin_user_id uuid not null,
  admin_username text not null,
  action text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint instance_server_audit_action_length check (char_length(action) between 1 and 80),
  constraint instance_server_audit_reason_length check (char_length(reason) between 1 and 240)
);

create index if not exists instance_server_audit_history_idx
  on instance_server_audit_logs(server_id, created_at desc, id desc);

create index if not exists users_username_search_idx
  on users(username_normalized collate "C", id);

create index if not exists users_display_name_search_idx
  on users((lower(display_name) collate "C"), id);
