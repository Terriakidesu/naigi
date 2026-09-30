alter table channels drop constraint if exists channels_kind;

alter table channels
  add constraint channels_kind check (kind in ('text', 'voice'));
