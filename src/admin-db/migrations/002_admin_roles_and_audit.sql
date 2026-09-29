alter table admin_users
  add column role text not null default 'admin';

alter table admin_users
  add constraint admin_users_role_check check (role in ('admin', 'moderator'));

create table admin_user_audit_logs (
  id bigint generated always as identity primary key,
  actor_admin_user_id uuid references admin_users(id) on delete set null,
  actor_username text not null,
  target_admin_user_id uuid references admin_users(id) on delete set null,
  target_username text not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_user_audit_action_length check (char_length(action) between 1 and 80)
);

create index admin_user_audit_logs_created_idx
  on admin_user_audit_logs(created_at desc, id desc);
