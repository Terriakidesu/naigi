create table if not exists instance_user_timeouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  created_by_admin_id uuid not null,
  created_by_username text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_admin_id uuid,
  revoked_by_username text,
  revocation_action text,
  constraint instance_user_timeouts_reason_length check (char_length(reason) between 1 and 240),
  constraint instance_user_timeouts_expiry check (expires_at > created_at),
  constraint instance_user_timeouts_revocation_action check (
    revocation_action is null or revocation_action in ('removed', 'replaced', 'expired')
  ),
  constraint instance_user_timeouts_revocation_state check (
    (revoked_at is null and revoked_by_admin_id is null and revoked_by_username is null and revocation_action is null)
    or (
      revoked_at is not null and revocation_action is not null
      and (
        (revocation_action = 'expired' and revoked_by_admin_id is null and revoked_by_username is null)
        or
        (revocation_action in ('removed', 'replaced') and revoked_by_admin_id is not null and revoked_by_username is not null)
      )
    )
  )
);

create unique index if not exists instance_user_timeouts_open_user_idx
  on instance_user_timeouts(user_id) where revoked_at is null;
create index if not exists instance_user_timeouts_user_history_idx
  on instance_user_timeouts(user_id, created_at desc, id desc);
