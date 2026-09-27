update server_roles
set permissions = (permissions #>> '{}')::jsonb
where jsonb_typeof(permissions) = 'string';
