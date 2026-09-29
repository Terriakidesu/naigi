import { closeAdminDatabase } from "./admin-db/client";
import { migrateAdminDatabase } from "./admin-db/migrate";
import { closeDatabase } from "./db/client";
import { migrate } from "./db/migrate";

try {
  await migrate();
  await migrateAdminDatabase();
} finally {
  await Promise.all([closeDatabase(), closeAdminDatabase()]);
}
