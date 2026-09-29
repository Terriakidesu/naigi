alter table instance_report_keys
  drop constraint if exists instance_report_keys_created_by_fkey;
alter table instance_user_suspensions
  drop constraint if exists instance_user_suspensions_created_by_fkey;
alter table instance_reports
  drop constraint if exists instance_reports_reviewed_by_fkey;
alter table instance_admin_audit_logs
  drop constraint if exists instance_admin_audit_logs_admin_user_id_fkey;

alter table instance_report_keys
  add column created_by_username text,
  add column created_by_display_name text;
update instance_report_keys k
set created_by_username = coalesce(u.username, 'legacy operator'),
    created_by_display_name = coalesce(u.display_name, 'Legacy operator')
from users u where u.id = k.created_by;
update instance_report_keys
set created_by_username = coalesce(created_by_username, 'legacy operator'),
    created_by_display_name = coalesce(created_by_display_name, 'Legacy operator');
alter table instance_report_keys
  alter column created_by_username set not null,
  alter column created_by_display_name set not null;

alter table instance_user_suspensions
  add column created_by_username text,
  add column created_by_display_name text;
update instance_user_suspensions s
set created_by_username = coalesce(u.username, 'legacy operator'),
    created_by_display_name = coalesce(u.display_name, 'Legacy operator')
from users u where u.id = s.created_by;
update instance_user_suspensions
set created_by_username = coalesce(created_by_username, 'legacy operator'),
    created_by_display_name = coalesce(created_by_display_name, 'Legacy operator');
alter table instance_user_suspensions
  alter column created_by_username set not null,
  alter column created_by_display_name set not null;

alter table instance_reports
  add column reviewed_by_username text,
  add column reviewed_by_display_name text;
update instance_reports r
set reviewed_by_username = u.username,
    reviewed_by_display_name = u.display_name
from users u where u.id = r.reviewed_by;

alter table instance_admin_audit_logs
  add column admin_username text,
  add column admin_display_name text;
update instance_admin_audit_logs l
set admin_username = coalesce(u.username, 'legacy operator'),
    admin_display_name = coalesce(u.display_name, 'Legacy operator')
from users u where u.id = l.admin_user_id;
update instance_admin_audit_logs
set admin_username = coalesce(admin_username, 'legacy operator'),
    admin_display_name = coalesce(admin_display_name, 'Legacy operator');
alter table instance_admin_audit_logs
  alter column admin_username set not null,
  alter column admin_display_name set not null;
