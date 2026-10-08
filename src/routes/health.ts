/**
 * Liveness and readiness.
 *
 * Liveness answers as long as the process is running. Readiness additionally requires PostgreSQL,
 * the operator database, and Redis, and returns 503 when any is down: Redis in particular is a hard
 * dependency for authentication, since limiting fails closed rather than admitting an unthrottled
 * attempt. Nothing here reveals versions, paths, or credentials.
 */

import { Elysia } from "elysia";
import { pingDatabase } from "../db/client";
import { pingAdminDatabase } from "../admin-db/client";
import { pingRedis } from "../redis/client";

export const healthRoutes = new Elysia()
  .get("/health/live", () => ({ status: "ok" }))
    .get("/health/ready", async ({ set }) => {
      const [database, adminDatabase, redis] = await Promise.allSettled([
        pingDatabase(), pingAdminDatabase(), pingRedis(),
      ]);
      const ready = database.status === "fulfilled"
        && adminDatabase.status === "fulfilled"
        && redis.status === "fulfilled";
      const response = {
        status: ready ? "ok" : "degraded",
        dependencies: {
          database: database.status === "fulfilled" ? "ok" : "unavailable",
          adminDatabase: adminDatabase.status === "fulfilled" ? "ok" : "unavailable",
          redis: redis.status === "fulfilled" ? "ok" : "unavailable",
        },
      };

      if (!ready) set.status = 503;
      return response;
    });
