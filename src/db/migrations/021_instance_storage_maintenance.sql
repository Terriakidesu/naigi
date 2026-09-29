alter table instance_admin_audit_logs
  add column details jsonb not null default '{}'::jsonb;

create table if not exists instance_storage_quarantine (
  id uuid primary key default gen_random_uuid(),
  storage_group text not null check (storage_group in ('attachments', 'profile_media')),
  storage_key text not null check (storage_key ~ '^[A-Fa-f0-9-]{36}[.][A-Za-z0-9]{1,12}$'),
  size_bytes bigint not null check (size_bytes >= 0),
  state text not null check (state in ('pending', 'quarantined', 'restoring', 'purging', 'restored', 'purged', 'failed', 'recovery_required')),
  quarantined_by_admin_id uuid not null,
  quarantined_by_username text not null,
  created_at timestamptz not null default now(),
  quarantined_at timestamptz,
  delete_after timestamptz,
  restored_at timestamptz,
  purged_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists instance_storage_quarantine_active_key_idx
  on instance_storage_quarantine(storage_group, storage_key)
  where state in ('pending', 'quarantined', 'restoring', 'purging', 'recovery_required');

create index if not exists instance_storage_quarantine_state_expiry_idx
  on instance_storage_quarantine(state, delete_after, created_at);
