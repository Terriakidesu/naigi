create table if not exists fcm_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fcm_push_subscriptions_token_length check (char_length(token) between 20 and 4096)
);

create index if not exists fcm_push_subscriptions_user_idx
  on fcm_push_subscriptions(user_id);
