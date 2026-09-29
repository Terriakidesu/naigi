create index if not exists users_created_at_idx
  on users(created_at desc);

create index if not exists sessions_last_used_user_idx
  on sessions(last_used_at desc, user_id, expires_at);
