alter table users
  add column if not exists profile_banner_storage_key text,
  add column if not exists profile_banner_mime_type text,
  add column if not exists profile_banner_size_bytes bigint;

create unique index if not exists users_profile_banner_storage_key_idx
  on users(profile_banner_storage_key)
  where profile_banner_storage_key is not null;

alter table users
  add constraint users_profile_banner_size_limit
    check (profile_banner_size_bytes is null or profile_banner_size_bytes between 1 and 5242880);

alter table servers
  add column if not exists landing_channel_id uuid references channels(id) on delete set null;

update servers
set landing_channel_id = onboarding_channel_id
where landing_channel_id is null
  and onboarding_channel_id is not null;

update servers s
set landing_channel_id = first_channel.id
from (
  select distinct on (server_id) server_id, id
  from channels
  where archived_at is null
  order by server_id, created_at asc, id asc
) first_channel
where s.id = first_channel.server_id
  and s.landing_channel_id is null;
