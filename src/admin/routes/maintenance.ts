/**
 * Instance storage maintenance.
 *
 * Quarantine and purge operate on files the database no longer references, so every action is gated
 * twice: by operator capability, and by an explicit preview showing exactly what would change. A
 * purge requires a prior preview, which is what stops a mistyped scope from deleting live media.
 */

import { Elysia } from "elysia";
import { authenticateAdmin } from "../../admin-auth/session";
import { adminCan } from "../../admin-auth/permissions";
import { respondError } from "../../http/responses";
import {
  getStorageMaintenanceSummary,
  inspectStorageMaintenance,
  purgeExpiredQuarantinedStorage,
  quarantineOrphanedStorage,
  restoreQuarantinedStorage,
  StorageMaintenanceError,
} from "../../admin-maintenance";

export const adminMaintenanceRoutes = new Elysia()
  .get("/v1/instance-admin/maintenance/summary", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await getStorageMaintenanceSummary(operator);
    })
    .post("/v1/instance-admin/maintenance/preview", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      return await inspectStorageMaintenance();
    })
    .post("/v1/instance-admin/maintenance/quarantine", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await quarantineOrphanedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/instance-admin/maintenance/restore", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await restoreQuarantinedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    })
    .post("/v1/instance-admin/maintenance/purge", async ({ headers, set }) => {
      const operator = await authenticateAdmin(headers.cookie);
      if (!operator) return respondError(set, 401, "unauthorized");
      if (!adminCan(operator.role, "platform")) return respondError(set, 403, "forbidden");
      set.headers["cache-control"] = "no-store";
      try {
        return await purgeExpiredQuarantinedStorage(operator);
      } catch (error) {
        if (error instanceof StorageMaintenanceError) return respondError(set, error.status, error.code);
        throw error;
      }
    });
