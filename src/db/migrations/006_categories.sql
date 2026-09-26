create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references servers(id) on delete cascade,
  created_by uuid not null references users(id) on delete cascade,
  encrypted_metadata bytea not null default decode('', 'base64'),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint categories_position_nonnegative check (position >= 0)
);

create index if not exists categories_server_position_idx on categories(server_id, position, created_at);

alter table channels add column if not exists category_id uuid references categories(id) on delete set null;
create index if not exists channels_category_id_idx on channels(category_id);
