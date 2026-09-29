create index if not exists messages_created_at_idx
  on messages(created_at desc);

create index if not exists attachments_created_at_idx
  on attachments(created_at desc);

create index if not exists server_custom_emojis_created_at_idx
  on server_custom_emojis(created_at desc);
