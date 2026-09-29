import { SQL } from "bun";
import { config } from "../config";

export const adminDb = new SQL(config.adminDatabaseUrl, {
  idleTimeout: 30,
  max: 5,
});

export async function pingAdminDatabase() {
  await adminDb`select 1 as ok`;
  return true;
}

export async function closeAdminDatabase() {
  await adminDb.close({ timeout: 1 });
}
