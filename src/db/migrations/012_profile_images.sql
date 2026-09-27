alter table users
  add column if not exists profile_image_storage_key text,
  add column if not exists profile_image_mime_type text,
  add column if not exists profile_image_size_bytes bigint;

create unique index if not exists users_profile_image_storage_key_idx
  on users(profile_image_storage_key)
  where profile_image_storage_key is not null;
