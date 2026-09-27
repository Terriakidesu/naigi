alter table users
  add constraint users_profile_image_size_limit
    check (profile_image_size_bytes is null or profile_image_size_bytes between 1 and 5242880);
