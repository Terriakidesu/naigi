with ranked_active_invites as (
  select
    id,
    row_number() over (partition by server_id order by created_at desc, id desc) as invite_rank
  from server_invites
  where revoked_at is null
)
update server_invites invite
set revoked_at = now()
from ranked_active_invites ranked
where invite.id = ranked.id
  and ranked.invite_rank > 1;

create unique index if not exists server_invites_one_active_per_server_idx
  on server_invites(server_id)
  where revoked_at is null;
