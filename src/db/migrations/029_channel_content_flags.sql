-- Content markers a client must act on before rendering a channel: an adult-content
-- warning and a channel-wide spoiler default. They are deliberately not part of the
-- encrypted metadata: a member added to a channel after its metadata was written may
-- never be able to decrypt it, and a warning hidden in ciphertext fails open.
alter table channels
  add column if not exists nsfw boolean not null default false,
  add column if not exists spoiler boolean not null default false;