import { createApp } from "./app";
import { config } from "./config";
import { closeDatabase } from "./db/client";
import { closeRedis } from "./redis/client";

// I have nothing but my burger and I want nothing more
const app = createApp().listen({ hostname: config.host, port: config.port });

console.log(`Naigi is running at http://${app.server?.hostname}:${app.server?.port}`);

const shutdown = async () => {
  app.stop();
  closeRedis();
  await closeDatabase();
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
