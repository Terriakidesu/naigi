create table if not exists crypto_fallback_keys (
  device_id text not null references crypto_devices(device_id) on delete cascade,
  key_id text not null,
  key_json jsonb not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (device_id, key_id)
);

create index if not exists crypto_fallback_keys_available_idx
  on crypto_fallback_keys(device_id, used_at, created_at);

insert into crypto_fallback_keys (device_id, key_id, key_json)
select d.device_id, item.key_id, item.key_json
from crypto_devices d
cross join lateral jsonb_each(d.fallback_keys) as item(key_id, key_json)
on conflict (device_id, key_id) do nothing;
