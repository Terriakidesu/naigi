alter table conversations drop constraint if exists conversations_kind;
alter table conversations
  add constraint conversations_kind check (kind in ('dm', 'group', 'channel'));

create table if not exists servers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  encrypted_metadata bytea not null default decode('', 'base64'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists servers_owner_id_idx on servers(owner_id);

create table if not exists server_members (
  server_id uuid not null references servers(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (server_id, user_id),
  constraint server_members_role check (role in ('owner', 'admin', 'member'))
);

create index if not exists server_members_user_id_idx on server_members(user_id);

create table if not exists channels (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  conversation_id uuid not null unique references conversations(id) on delete cascade,
  created_by uuid not null references users(id) on delete cascade,
  encrypted_metadata bytea not null default decode('', 'base64'),
  kind text not null default 'text',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint channels_kind check (kind in ('text')),
  constraint channels_position_nonnegative check (position >= 0)
);

create index if not exists channels_server_position_idx on channels(server_id, position, created_at);

create table if not exists server_invites (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  created_by uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  max_uses integer not null default 0,
  uses integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint server_invites_max_uses_nonnegative check (max_uses >= 0),
  constraint server_invites_uses_nonnegative check (uses >= 0),
  constraint server_invites_uses_within_limit check (max_uses = 0 or uses <= max_uses)
);

create index if not exists server_invites_server_id_idx on server_invites(server_id);
