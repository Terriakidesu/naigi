create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_normalized text not null unique,
  password_hash text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_username_length check (char_length(username) between 3 and 32),
  constraint users_display_name_length check (char_length(display_name) between 1 and 80)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  identity_key bytea not null,
  signed_prekey bytea not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint devices_name_length check (char_length(name) between 1 and 80)
);

create index if not exists devices_user_id_idx on devices(user_id);

create table if not exists one_time_prekeys (
  device_id uuid not null references devices(id) on delete cascade,
  key_id integer not null,
  public_key bytea not null,
  consumed_at timestamptz,
  primary key (device_id, key_id),
  constraint one_time_prekeys_key_id_nonnegative check (key_id >= 0)
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  encrypted_metadata bytea not null default decode('', 'base64'),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  constraint conversations_kind check (kind in ('dm', 'group'))
);

create index if not exists conversations_created_by_idx on conversations(created_by);

create table if not exists conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (conversation_id, user_id),
  constraint conversation_members_role check (role in ('owner', 'member'))
);

create index if not exists conversation_members_user_id_idx on conversation_members(user_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_device_id uuid not null references devices(id),
  client_message_id uuid not null,
  server_sequence bigint generated always as identity unique,
  protocol text not null,
  ciphertext bytea not null,
  protocol_metadata bytea not null default decode('', 'base64'),
  created_at timestamptz not null default now(),
  constraint messages_protocol_length check (char_length(protocol) between 1 and 32),
  unique (sender_device_id, client_message_id)
);

create index if not exists messages_conversation_sequence_idx
  on messages(conversation_id, server_sequence desc);

create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
