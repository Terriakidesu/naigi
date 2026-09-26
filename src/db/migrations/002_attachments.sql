create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  uploaded_by uuid not null references users(id) on delete cascade,
  storage_key text not null unique,
  file_extension text not null,
  mime_type text not null,
  expected_size_bytes bigint not null,
  size_bytes bigint,
  sha256 bytea,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  constraint attachments_expected_size_positive check (expected_size_bytes > 0),
  constraint attachments_file_extension check (file_extension ~ '^[a-z0-9]{1,12}$'),
  constraint attachments_mime_type check (mime_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  constraint attachments_status check (status in ('pending', 'uploaded')),
  constraint attachments_uploaded_fields check (
    (status = 'pending' and size_bytes is null and sha256 is null and uploaded_at is null)
    or
    (status = 'uploaded' and size_bytes is not null and sha256 is not null and uploaded_at is not null)
  )
);

create index if not exists attachments_conversation_id_idx on attachments(conversation_id);
create index if not exists attachments_uploaded_by_idx on attachments(uploaded_by);
