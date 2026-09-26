create table if not exists crypto_devices (
  device_id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  matrix_user_id text not null,
  device_keys jsonb not null,
  fallback_keys jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint crypto_devices_device_id_length check (char_length(device_id) between 1 and 255),
  constraint crypto_devices_matrix_user_id_length check (char_length(matrix_user_id) between 1 and 255)
);

create index if not exists crypto_devices_user_id_idx on crypto_devices(user_id);
create index if not exists crypto_devices_matrix_user_id_idx on crypto_devices(matrix_user_id);

create table if not exists crypto_one_time_keys (
  device_id text not null references crypto_devices(device_id) on delete cascade,
  key_id text not null,
  key_json jsonb not null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (device_id, key_id)
);

create index if not exists crypto_one_time_keys_available_idx
  on crypto_one_time_keys(device_id, claimed_at, created_at);

create table if not exists crypto_to_device_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  transaction_id text not null,
  sender_user_id text not null,
  recipient_device_id text not null references crypto_devices(device_id) on delete cascade,
  content jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (event_type, transaction_id, sender_user_id, recipient_device_id)
);

create index if not exists crypto_to_device_events_pending_idx
  on crypto_to_device_events(recipient_device_id, delivered_at, id);
