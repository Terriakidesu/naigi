create table if not exists server_role_category_access (
  role_id uuid not null references server_roles(id) on delete cascade,
  category_id uuid not null references categories(id) on delete cascade,
  can_view boolean not null default true,
  can_upload boolean not null default false,
  primary key (role_id, category_id)
);

create index if not exists server_role_category_access_category_idx
  on server_role_category_access(category_id, role_id);

alter table servers
  add column if not exists onboarding_channel_id uuid references channels(id) on delete set null;

update servers s
set onboarding_channel_id = first_channel.id
from (
  select distinct on (server_id) server_id, id
  from channels
  where archived_at is null
  order by server_id, created_at asc, id asc
) first_channel
where s.id = first_channel.server_id
  and s.onboarding_channel_id is null;
