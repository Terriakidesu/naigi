alter table server_roles
  add column if not exists separate_members boolean not null default false;

-- Preserve the existing member grouping until administrators choose to flatten roles.
update server_roles
set separate_members = true
where system_key in ('owner', 'admin') or not is_system;
