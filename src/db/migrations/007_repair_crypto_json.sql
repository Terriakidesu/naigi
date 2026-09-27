-- Bun SQL serializes JSONB parameters itself. Earlier writes passed
-- JSON.stringify(value), storing JSON strings instead of Matrix key objects.
-- Repair in place without replacing device identities or message ciphertext.
update crypto_devices
set device_keys = (device_keys #>> '{}')::jsonb
where jsonb_typeof(device_keys) = 'string';

update crypto_devices
set fallback_keys = (fallback_keys #>> '{}')::jsonb
where jsonb_typeof(fallback_keys) = 'string';

-- Unsigned keys may legitimately be bare strings; unwrap serialized objects
-- (signed keys) and serialized strings only, leaving bare base64 keys alone.
update crypto_one_time_keys
set key_json = (key_json #>> '{}')::jsonb
where jsonb_typeof(key_json) = 'string'
  and left(ltrim(key_json #>> '{}'), 1) in ('{', '"');

update crypto_fallback_keys
set key_json = (key_json #>> '{}')::jsonb
where jsonb_typeof(key_json) = 'string'
  and left(ltrim(key_json #>> '{}'), 1) in ('{', '"');

-- Malformed events previously acknowledged by a client need another delivery.
update crypto_to_device_events
set content = (content #>> '{}')::jsonb, delivered_at = null
where jsonb_typeof(content) = 'string';

alter table crypto_devices
  add constraint crypto_devices_keys_object check (jsonb_typeof(device_keys) = 'object'),
  add constraint crypto_devices_fallback_object check (jsonb_typeof(fallback_keys) = 'object');
alter table crypto_one_time_keys
  add constraint crypto_one_time_keys_signed_object
  check (key_id not like 'signed_%' or jsonb_typeof(key_json) = 'object');
alter table crypto_fallback_keys
  add constraint crypto_fallback_keys_signed_object
  check (key_id not like 'signed_%' or jsonb_typeof(key_json) = 'object');
alter table crypto_to_device_events
  add constraint crypto_to_device_content_object check (jsonb_typeof(content) = 'object');
