/**
 * Instance operations telemetry.
 *
 * Read-only views of runtime state, served to operators holding the `platform` capability. The live
 * view is derived from Redis connection leases, which expire on their own, so an unavailable Redis
 * degrades the numbers rather than failing the request.
 */

import { Elysia } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { respondError } from "../../http/responses";
import {
  getInstanceLiveResources,
  getInstanceOperationsOverview,
  getInstanceOperationsSnapshot,
} from "../../admin-operations";

export const adminOperationsRoutes = new Elysia()
  .get("/v1/instance-admin/operations", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getInstanceOperationsSnapshot();
    })
    .get("/v1/instance-admin/operations/live", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return getInstanceLiveResources();
    })
    .get("/v1/instance-admin/operations/overview", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getInstanceOperationsOverview();
    });
