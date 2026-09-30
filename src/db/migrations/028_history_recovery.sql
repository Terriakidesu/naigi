create table encrypted_history_backups (
  user_id uuid primary key references users(id) on delete cascade,
  backup_id uuid not null,
  revision bigint not null default 1,
  encrypted_key text not null,
  encrypted_export text not null,
  updated_at timestamptz not null default now()
);

create table history_device_transfers (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  requester_device_id text not null references crypto_devices(device_id) on delete cascade,
  approver_device_id text references crypto_devices(device_id) on delete cascade,
  secret_hash text not null,
  encrypted_payload text,
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  created_at timestamptz not null default now(),
  constraint history_transfer_hash_format check (secret_hash ~ '^[0-9a-f]{64}$')
);
create index history_device_transfers_user_expiry on history_device_transfers(user_id, expires_at);
