import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { db, closeDatabase } from "./client";

const migrationsDirectory = join(import.meta.dir, "migrations");

async function migrate() {
  await db`create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )`;

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const [existing] = await db<{ version: string }[]>`
      select version from schema_migrations where version = ${version}
    `;

    if (existing) continue;

    const migration = await Bun.file(join(migrationsDirectory, file)).text();
    await db.begin(async (transaction) => {
      await transaction(migration).simple();
      await transaction`insert into schema_migrations (version) values (${version})`;
    });

    console.log(`Applied migration ${version}`);
  }
}

if (import.meta.main) {
  try {
    await migrate();
  } finally {
    await closeDatabase();
  }
}

export { migrate };
