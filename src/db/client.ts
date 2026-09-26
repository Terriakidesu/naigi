import { SQL } from "bun";
import { config } from "../config";

export const db = new SQL(config.databaseUrl, {
  idleTimeout: 30,
  max: 10,
});

export async function pingDatabase() {
  await db`select 1 as ok`;
  return true;
}

export async function closeDatabase() {
  await db.close({ timeout: 1 });
}
