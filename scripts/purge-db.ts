import { closeDatabase, db } from "../src/db/client";
import { config } from "../src/config";

const confirmed = Bun.argv.includes("--yes");

if (!confirmed) {
  console.error("Refusing to purge the database without --yes.");
  console.error("Run: bun run db:purge -- --yes");
  process.exitCode = 1;
} else if (config.environment === "production") {
  console.error("Refusing to purge a production database.");
  process.exitCode = 1;
} else {
  try {
    await db.begin(async (transaction) => {
      await transaction`
        truncate table
          users,
          sessions,
          devices,
          one_time_prekeys,
          conversations,
          conversation_members,
          messages,
          attachments,
          crypto_devices,
          crypto_one_time_keys,
          crypto_to_device_events,
          crypto_fallback_keys,
          server_invites,
          channels,
          server_members,
          servers
        restart identity cascade
      `;
    });

    const [counts] = await db`
      select
        (select count(*) from users) as users,
        (select count(*) from sessions) as sessions,
        (select count(*) from devices) as devices,
        (select count(*) from conversations) as conversations,
        (select count(*) from messages) as messages,
        (select count(*) from attachments) as attachments,
        (select count(*) from crypto_devices) as crypto_devices,
        (select count(*) from crypto_one_time_keys) as crypto_one_time_keys,
        (select count(*) from crypto_fallback_keys) as crypto_fallback_keys,
        (select count(*) from crypto_to_device_events) as crypto_to_device_events,
        (select count(*) from servers) as servers,
        (select count(*) from server_members) as server_members,
        (select count(*) from channels) as channels,
        (select count(*) from server_invites) as server_invites
    `;
    console.log("Database purged:", counts);
  } finally {
    await closeDatabase();
  }
}
