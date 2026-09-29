create table if not exists user_blocks (
  blocker_user_id uuid not null references users(id) on delete cascade,
  blocked_user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  constraint user_blocks_no_self check (blocker_user_id <> blocked_user_id)
);

create index if not exists user_blocks_blocked_idx on user_blocks(blocked_user_id, blocker_user_id);

create table if not exists instance_report_keys (
  id uuid primary key default gen_random_uuid(),
  public_key bytea not null,
  created_by uuid not null references users(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint instance_report_keys_size check (octet_length(public_key) between 256 and 2048)
);

create unique index if not exists instance_report_keys_one_active_idx
  on instance_report_keys(active) where active;

create table if not exists instance_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_user_id uuid references users(id) on delete set null,
  target_user_id uuid references users(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid,
  reason text not null,
  status text not null default 'open',
  evidence_key_id uuid references instance_report_keys(id) on delete set null,
  evidence_ciphertext bytea,
  evidence_wrapped_key bytea,
  evidence_iv bytea,
  created_at timestamptz not null default now(),
  reviewed_by uuid references users(id) on delete set null,
  reviewed_at timestamptz,
  constraint instance_reports_reason check (reason in ('spam', 'harassment', 'threats', 'sexual_content', 'illegal_content', 'impersonation', 'other')),
  constraint instance_reports_status check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  constraint instance_reports_evidence_complete check (
    (evidence_key_id is null and evidence_ciphertext is null and evidence_wrapped_key is null and evidence_iv is null)
    or
    (evidence_key_id is not null and evidence_ciphertext is not null and evidence_wrapped_key is not null and evidence_iv is not null)
  )
);

create index if not exists instance_reports_queue_idx on instance_reports(status, created_at desc);
create index if not exists instance_reports_target_idx on instance_reports(target_user_id, created_at desc);
create unique index if not exists instance_reports_active_message_report_idx
  on instance_reports(reporter_user_id, message_id)
  where message_id is not null and status in ('open', 'reviewing');

create table if not exists instance_user_suspensions (
  user_id uuid primary key references users(id) on delete cascade,
  created_by uuid not null references users(id),
  report_id uuid references instance_reports(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists instance_admin_audit_logs (
  id bigint generated always as identity primary key,
  admin_user_id uuid not null references users(id),
  action text not null,
  report_id uuid references instance_reports(id) on delete set null,
  target_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint instance_admin_audit_action_length check (char_length(action) between 1 and 80)
);

create index if not exists instance_admin_audit_created_idx
  on instance_admin_audit_logs(created_at desc, id desc);
