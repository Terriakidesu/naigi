import { link, lstat, mkdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "../db/client";
import { config } from "../config";
import type { AuthenticatedAdmin } from "../admin-auth/session";
import {
  storageDirectoriesOverlap,
  storageReferences,
  type StorageReferences,
} from "../admin-operations";
import {
  scanStorageDirectory,
  type OrphanCandidate,
} from "../admin-operations/storage-scan";

const minimumOrphanAgeMs = 24 * 60 * 60 * 1_000;
const quarantineRetentionDays = 30;
const maximumFilesPerAction = 500;
const quarantineDirectoryName = ".naigi-quarantine";
const validStorageKey = /^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i;

type StorageGroup = "attachments" | "profile_media";
type Candidate = { group: StorageGroup; file: OrphanCandidate };
type AuditDetails = Record<string, number | string | boolean | null>;
type QuarantineRow = {
  id: string;
  storage_group: StorageGroup;
  storage_key: string;
  size_bytes: string | number | bigint;
  state: string;
  quarantined_by_admin_id: string;
  quarantined_by_username: string;
  delete_after: Date | null;
};

export class StorageMaintenanceError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
    this.name = "StorageMaintenanceError";
  }
}

function rootFor(group: StorageGroup) {
  return group === "attachments" ? config.attachmentsDirectory : config.profileImagesDirectory;
}

function safeStoragePath(group: StorageGroup, storageKey: string) {
  if (!validStorageKey.test(storageKey)) throw new StorageMaintenanceError("invalid_quarantine_record");
  return join(resolve(rootFor(group)), storageKey);
}

function quarantineDirectoryFor(group: StorageGroup) {
  return join(resolve(rootFor(group)), quarantineDirectoryName);
}

function quarantinePath(group: StorageGroup, storageKey: string) {
  if (!validStorageKey.test(storageKey)) throw new StorageMaintenanceError("invalid_quarantine_record");
  return join(quarantineDirectoryFor(group), storageKey);
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error
    && (error as { code?: string }).code === "ENOENT");
}

async function pathState(path: string): Promise<"file" | "missing" | "unsafe"> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? "file" : "unsafe";
  } catch (error) {
    return isMissing(error) ? "missing" : "unsafe";
  }
}

async function fileInfo(path: string) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() ? info : null;
  } catch {
    return null;
  }
}

async function moveWithoutOverwrite(source: string, target: string) {
  await link(source, target);
  try {
    await unlink(source);
  } catch (error) {
    const [sourceInfo, targetInfo] = await Promise.all([fileInfo(source), fileInfo(target)]);
    if (sourceInfo && targetInfo && sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino) {
      await unlink(target).catch(() => undefined);
    }
    throw error;
  }
}

async function ensureQuarantineDirectory(group: StorageGroup) {
  const root = resolve(rootFor(group));
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new StorageMaintenanceError("storage_directory_unavailable", 503);
  const directory = quarantineDirectoryFor(group);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || (error as { code?: string }).code !== "EEXIST") {
      throw new StorageMaintenanceError("quarantine_unavailable", 503);
    }
  }
  const directoryInfo = await lstat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.dev !== rootInfo.dev) {
    throw new StorageMaintenanceError("quarantine_unavailable", 503);
  }
  return directory;
}

function candidateIdentityMatches(candidate: OrphanCandidate, info: Awaited<ReturnType<typeof lstat>>) {
  return info.isFile()
    && !info.isSymbolicLink()
    && info.size === candidate.sizeBytes
    && info.mtimeMs === candidate.mtimeMs
    && info.dev === candidate.device
    && info.ino === candidate.inode;
}

function emptyPreparedScan(blockers: string[] = []) {
  return {
    complete: false,
    blockers,
    candidateCount: 0,
    candidateBytes: 0,
    candidates: [] as Candidate[],
    scannedAt: new Date().toISOString(),
  };
}

async function prepareCandidateScan(connection: typeof db) {
  if (await storageDirectoriesOverlap()) return emptyPreparedScan(["storage_directories_overlap"]);

  let references: StorageReferences;
  try {
    references = await storageReferences(connection);
  } catch {
    return emptyPreparedScan(["references_unavailable"]);
  }

  const blockers = new Set<string>();
  if (!references.attachmentFilesComplete || !references.profileMediaFilesComplete) blockers.add("reference_limit_reached");
  let candidateCount = 0;
  let candidateBytes = 0;
  const candidates: Candidate[] = [];
  const now = Date.now();
  const collect = (group: StorageGroup) => (file: OrphanCandidate) => {
    if (!validStorageKey.test(file.storageKey) || now - file.mtimeMs < minimumOrphanAgeMs) return;
    candidateCount += 1;
    candidateBytes += file.sizeBytes;
    if (candidates.length < maximumFilesPerAction) candidates.push({ group, file });
  };

  const [attachmentScan, profileScan] = await Promise.all([
    scanStorageDirectory(config.attachmentsDirectory, references.attachmentFiles, {
      now,
      referenceListComplete: references.attachmentFilesComplete,
      onOrphanCandidate: collect("attachments"),
    }).catch(() => null),
    scanStorageDirectory(config.profileImagesDirectory, references.profileMediaFiles, {
      now,
      referenceListComplete: references.profileMediaFilesComplete,
      onOrphanCandidate: collect("profile_media"),
    }).catch(() => null),
  ]);

  if (!attachmentScan?.complete || !profileScan?.complete) blockers.add("scan_incomplete");
  return {
    complete: blockers.size === 0,
    blockers: [...blockers],
    candidateCount,
    candidateBytes,
    candidates,
    scannedAt: new Date(now).toISOString(),
  };
}

async function isStorageKeyReferenced(connection: typeof db, group: StorageGroup, storageKey: string) {
  if (group === "attachments") {
    const [row] = await connection<{ referenced: boolean }[]>`
      select exists(select 1 from attachments where storage_key = ${storageKey})
        or exists(select 1 from server_custom_emojis where storage_key = ${storageKey}) as referenced
    `;
    return row?.referenced === true;
  }
  const [row] = await connection<{ referenced: boolean }[]>`
    select exists(select 1 from users where profile_image_storage_key = ${storageKey})
      or exists(select 1 from users where profile_banner_storage_key = ${storageKey})
      or exists(select 1 from servers where icon_storage_key = ${storageKey})
      or exists(select 1 from servers where banner_storage_key = ${storageKey}) as referenced
  `;
  return row?.referenced === true;
}

async function recordMaintenanceAudit(
  connection: typeof db,
  operator: AuthenticatedAdmin,
  action: string,
  details: AuditDetails,
) {
  await connection`
    insert into instance_admin_audit_logs (
      admin_user_id, admin_username, admin_display_name, action, details
    ) values (
      ${operator.id}, ${operator.username}, ${operator.username}, ${action}, ${JSON.stringify(details)}::jsonb
    )
  `;
}

async function auditRecoveredTransition(connection: typeof db, operator: AuthenticatedAdmin, row: QuarantineRow, action: string) {
  await connection`
    insert into instance_admin_audit_logs (
      admin_user_id, admin_username, admin_display_name, action, details
    ) values (
      ${operator.id}, ${operator.username}, ${operator.username},
      ${action}, ${JSON.stringify({ fileCount: 1, bytes: Number(row.size_bytes), recoveredAfterInterruption: true })}::jsonb
    )
  `;
}

async function finalizeStaleTransition(operator: AuthenticatedAdmin, row: QuarantineRow) {
  const source = safeStoragePath(row.storage_group, row.storage_key);
  const quarantined = quarantinePath(row.storage_group, row.storage_key);
  const [sourceState, quarantineState] = await Promise.all([pathState(source), pathState(quarantined)]);
  const [sourceInfo, quarantineInfo] = sourceState === "file" && quarantineState === "file"
    ? await Promise.all([fileInfo(source), fileInfo(quarantined)])
    : [null, null];

  await db.begin(async (transaction) => {
    if (row.state === "pending") {
      if (sourceState === "missing" && quarantineState === "file") {
        await transaction`
          update instance_storage_quarantine
          set state = 'quarantined', quarantined_at = coalesce(quarantined_at, now()),
            delete_after = coalesce(delete_after, now() + make_interval(days => ${quarantineRetentionDays})), updated_at = now()
          where id = ${row.id} and state = 'pending'
        `;
        await auditRecoveredTransition(transaction, operator, row, "storage.quarantine.reconciled");
      } else if (sourceState === "file" && quarantineState === "missing") {
        await transaction`update instance_storage_quarantine set state = 'failed', updated_at = now() where id = ${row.id} and state = 'pending'`;
      } else if (sourceInfo && quarantineInfo && sourceInfo.dev === quarantineInfo.dev && sourceInfo.ino === quarantineInfo.ino) {
        await unlink(quarantined);
        await transaction`update instance_storage_quarantine set state = 'failed', updated_at = now() where id = ${row.id} and state = 'pending'`;
      } else {
        await transaction`update instance_storage_quarantine set state = 'recovery_required', updated_at = now() where id = ${row.id} and state = 'pending'`;
      }
    } else if (row.state === "restoring") {
      if (sourceState === "file" && quarantineState === "missing") {
        await transaction`
          update instance_storage_quarantine set state = 'restored', restored_at = coalesce(restored_at, now()), updated_at = now()
          where id = ${row.id} and state = 'restoring'
        `;
        await auditRecoveredTransition(transaction, operator, row, "storage.restore.reconciled");
      } else if (sourceState === "missing" && quarantineState === "file") {
        await transaction`update instance_storage_quarantine set state = 'quarantined', updated_at = now() where id = ${row.id} and state = 'restoring'`;
      } else if (sourceInfo && quarantineInfo && sourceInfo.dev === quarantineInfo.dev && sourceInfo.ino === quarantineInfo.ino) {
        await unlink(quarantined);
        await transaction`
          update instance_storage_quarantine set state = 'restored', restored_at = coalesce(restored_at, now()), updated_at = now()
          where id = ${row.id} and state = 'restoring'
        `;
        await auditRecoveredTransition(transaction, operator, row, "storage.restore.reconciled");
      } else {
        await transaction`update instance_storage_quarantine set state = 'recovery_required', updated_at = now() where id = ${row.id} and state = 'restoring'`;
      }
    } else if (row.state === "purging") {
      if (quarantineState === "missing") {
        await transaction`
          update instance_storage_quarantine set state = 'purged', purged_at = coalesce(purged_at, now()), updated_at = now()
          where id = ${row.id} and state = 'purging'
        `;
        await auditRecoveredTransition(transaction, operator, row, "storage.purge.reconciled");
      } else if (quarantineState === "file") {
        await transaction`update instance_storage_quarantine set state = 'quarantined', updated_at = now() where id = ${row.id} and state = 'purging'`;
      } else {
        await transaction`update instance_storage_quarantine set state = 'recovery_required', updated_at = now() where id = ${row.id} and state = 'purging'`;
      }
    }
  });
}

async function reconcileStaleTransitions(operator: AuthenticatedAdmin) {
  const pending = await db<QuarantineRow[]>`
    select id, storage_group, storage_key, size_bytes, state, quarantined_by_admin_id,
      quarantined_by_username, delete_after
    from instance_storage_quarantine
    where state in ('pending', 'restoring', 'purging') and updated_at < now() - interval '1 hour'
    order by updated_at asc limit ${maximumFilesPerAction}
  `;
  for (const row of pending) await finalizeStaleTransition(operator, row);
}

function toSafeCount(value: string | number | bigint | null | undefined) {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export async function inspectStorageMaintenance() {
  const scan = await prepareCandidateScan(db);
  return {
    complete: scan.complete,
    blockers: scan.blockers,
    candidateFileCount: scan.candidateCount,
    candidateBytes: scan.candidateBytes,
    actionLimit: maximumFilesPerAction,
    minimumFileAgeHours: minimumOrphanAgeMs / (60 * 60 * 1_000),
    retentionDays: quarantineRetentionDays,
    scannedAt: scan.scannedAt,
  };
}

export async function quarantineOrphanedStorage(operator: AuthenticatedAdmin) {
  const scan = await prepareCandidateScan(db);
  if (!scan.complete) throw new StorageMaintenanceError("maintenance_scan_incomplete");
  await recordMaintenanceAudit(db, operator, "storage.quarantine_started", { actionLimit: maximumFilesPerAction });

  let quarantinedFileCount = 0;
  let quarantinedBytes = 0;
  let skippedReferencedCount = 0;
  let skippedChangedCount = 0;
  let skippedManagedCount = 0;
  let failedCount = 0;

  for (const candidate of scan.candidates) {
    const { group, file } = candidate;
    const source = safeStoragePath(group, file.storageKey);
    const targetDirectory = await ensureQuarantineDirectory(group).catch(() => null);
    if (!targetDirectory) {
      failedCount += 1;
      continue;
    }
    const target = join(targetDirectory, file.storageKey);
    const current = await lstat(source).catch(() => null);
    if (!current || !candidateIdentityMatches(file, current) || Date.now() - current.mtimeMs < minimumOrphanAgeMs) {
      skippedChangedCount += 1;
      continue;
    }
    if (await pathState(target) !== "missing") {
      skippedManagedCount += 1;
      continue;
    }

    const [pending] = await db<{ id: string }[]>`
      insert into instance_storage_quarantine (
        storage_group, storage_key, size_bytes, state, quarantined_by_admin_id, quarantined_by_username
      ) values (
        ${group}, ${file.storageKey}, ${file.sizeBytes}, 'pending', ${operator.id}, ${operator.username}
      ) on conflict do nothing returning id
    `;
    if (!pending) {
      skippedManagedCount += 1;
      continue;
    }

    if (await isStorageKeyReferenced(db, group, file.storageKey).catch(() => true)) {
      await db`update instance_storage_quarantine set state = 'failed', updated_at = now() where id = ${pending.id} and state = 'pending'`;
      skippedReferencedCount += 1;
      continue;
    }
    const latest = await lstat(source).catch(() => null);
    if (!latest || !candidateIdentityMatches(file, latest) || Date.now() - latest.mtimeMs < minimumOrphanAgeMs) {
      await db`update instance_storage_quarantine set state = 'failed', updated_at = now() where id = ${pending.id} and state = 'pending'`;
      skippedChangedCount += 1;
      continue;
    }
    if (await pathState(target) !== "missing") {
      await db`update instance_storage_quarantine set state = 'failed', updated_at = now() where id = ${pending.id} and state = 'pending'`;
      skippedManagedCount += 1;
      continue;
    }

    try {
      await moveWithoutOverwrite(source, target);
    } catch {
      await db`update instance_storage_quarantine set state = 'failed', updated_at = now() where id = ${pending.id} and state = 'pending'`;
      failedCount += 1;
      continue;
    }

    try {
      await db.begin(async (transaction) => {
        await transaction`
          update instance_storage_quarantine
          set state = 'quarantined', quarantined_at = now(),
            delete_after = now() + make_interval(days => ${quarantineRetentionDays}), updated_at = now()
          where id = ${pending.id} and state = 'pending'
        `;
      });
      quarantinedFileCount += 1;
      quarantinedBytes += file.sizeBytes;
    } catch {
      // The durable pending row lets the next maintenance visit reconcile a completed rename.
      failedCount += 1;
    }
  }

  const remainingCandidateCount = Math.max(0, scan.candidateCount - scan.candidates.length);
  await recordMaintenanceAudit(db, operator, "storage.quarantine_batch", {
    fileCount: quarantinedFileCount,
    bytes: quarantinedBytes,
    skippedReferencedCount,
    skippedChangedCount,
    skippedManagedCount,
    failedCount,
    remainingCandidateCount,
    retentionDays: quarantineRetentionDays,
  });
  return {
    quarantinedFileCount,
    quarantinedBytes,
    skippedReferencedCount,
    skippedChangedCount,
    skippedManagedCount,
    failedCount,
    remainingCandidateCount,
    retentionDays: quarantineRetentionDays,
  };
}

export async function getStorageMaintenanceSummary(operator: AuthenticatedAdmin) {
  await reconcileStaleTransitions(operator);
  const [row] = await db<{
    quarantined_count: string;
    quarantined_bytes: string;
    purgeable_count: string;
    purgeable_bytes: string;
    transitioning_count: string;
    recovery_required_count: string;
    next_purge_at: Date | null;
  }[]>`
    select
      count(*) filter (where state = 'quarantined')::text as quarantined_count,
      coalesce(sum(size_bytes) filter (where state = 'quarantined'), 0)::text as quarantined_bytes,
      count(*) filter (where state = 'quarantined' and delete_after <= now())::text as purgeable_count,
      coalesce(sum(size_bytes) filter (where state = 'quarantined' and delete_after <= now()), 0)::text as purgeable_bytes,
      count(*) filter (where state in ('pending', 'restoring', 'purging'))::text as transitioning_count,
      count(*) filter (where state = 'recovery_required')::text as recovery_required_count,
      min(delete_after) filter (where state = 'quarantined') as next_purge_at
    from instance_storage_quarantine
  `;
  return {
    quarantinedFileCount: toSafeCount(row?.quarantined_count),
    quarantinedBytes: toSafeCount(row?.quarantined_bytes),
    purgeableFileCount: toSafeCount(row?.purgeable_count),
    purgeableBytes: toSafeCount(row?.purgeable_bytes),
    transitioningFileCount: toSafeCount(row?.transitioning_count),
    recoveryRequiredFileCount: toSafeCount(row?.recovery_required_count),
    nextPurgeAt: row?.next_purge_at?.toISOString() ?? null,
    retentionDays: quarantineRetentionDays,
    actionLimit: maximumFilesPerAction,
  };
}

async function listQuarantineRows(state: "quarantined", expiryOnly = false) {
  return expiryOnly
    ? await db<QuarantineRow[]>`
      select id, storage_group, storage_key, size_bytes, state, quarantined_by_admin_id,
        quarantined_by_username, delete_after
      from instance_storage_quarantine
      where state = ${state} and delete_after <= now()
      order by delete_after asc, created_at asc limit ${maximumFilesPerAction}
    `
    : await db<QuarantineRow[]>`
      select id, storage_group, storage_key, size_bytes, state, quarantined_by_admin_id,
        quarantined_by_username, delete_after
      from instance_storage_quarantine where state = ${state}
      order by created_at asc limit ${maximumFilesPerAction}
    `;
}

export async function restoreQuarantinedStorage(operator: AuthenticatedAdmin) {
  if (await storageDirectoriesOverlap()) throw new StorageMaintenanceError("storage_directories_overlap");
  const rows = await listQuarantineRows("quarantined");
  await recordMaintenanceAudit(db, operator, "storage.restore_started", { actionLimit: maximumFilesPerAction });
  let restoredFileCount = 0;
  let restoredBytes = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const source = safeStoragePath(row.storage_group, row.storage_key);
    const quarantined = quarantinePath(row.storage_group, row.storage_key);
    if (await pathState(quarantined) !== "file" || await pathState(source) !== "missing") {
      skippedCount += 1;
      continue;
    }
    const [transition] = await db<{ id: string }[]>`
      update instance_storage_quarantine set state = 'restoring', updated_at = now()
      where id = ${row.id} and state = 'quarantined' returning id
    `;
    if (!transition) {
      skippedCount += 1;
      continue;
    }
    try {
      await mkdir(resolve(rootFor(row.storage_group)), { recursive: true });
      await moveWithoutOverwrite(quarantined, source);
      await db.begin(async (transaction) => {
        await transaction`
          update instance_storage_quarantine set state = 'restored', restored_at = now(), updated_at = now()
          where id = ${row.id} and state = 'restoring'
        `;
      });
      restoredFileCount += 1;
      restoredBytes += toSafeCount(row.size_bytes);
    } catch {
      skippedCount += 1;
      const sourceState = await pathState(source);
      const quarantineState = await pathState(quarantined);
      if (sourceState === "missing" && quarantineState === "file") {
        await db`update instance_storage_quarantine set state = 'quarantined', updated_at = now() where id = ${row.id} and state = 'restoring'`;
      }
    }
  }

  await recordMaintenanceAudit(db, operator, "storage.restore_batch", {
    fileCount: restoredFileCount,
    bytes: restoredBytes,
    skippedCount,
  });
  return { restoredFileCount, restoredBytes, skippedCount, remainingCount: Math.max(0, (await getStorageMaintenanceSummary(operator)).quarantinedFileCount) };
}

export async function purgeExpiredQuarantinedStorage(operator: AuthenticatedAdmin) {
  const rows = await listQuarantineRows("quarantined", true);
  await recordMaintenanceAudit(db, operator, "storage.purge_started", { actionLimit: maximumFilesPerAction });
  let purgedFileCount = 0;
  let purgedBytes = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const quarantined = quarantinePath(row.storage_group, row.storage_key);
    if (await pathState(quarantined) === "unsafe") {
      await db`update instance_storage_quarantine set state = 'recovery_required', updated_at = now() where id = ${row.id} and state = 'quarantined'`;
      skippedCount += 1;
      continue;
    }
    const [transition] = await db<{ id: string }[]>`
      update instance_storage_quarantine set state = 'purging', updated_at = now()
      where id = ${row.id} and state = 'quarantined' and delete_after <= now()
      returning id
    `;
    if (!transition) {
      skippedCount += 1;
      continue;
    }
    try {
      await unlink(quarantined).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await db.begin(async (transaction) => {
        await transaction`
          update instance_storage_quarantine set state = 'purged', purged_at = now(), updated_at = now()
          where id = ${row.id} and state = 'purging'
        `;
      });
      purgedFileCount += 1;
      purgedBytes += toSafeCount(row.size_bytes);
    } catch {
      skippedCount += 1;
      if (await pathState(quarantined) === "file") {
        await db`update instance_storage_quarantine set state = 'quarantined', updated_at = now() where id = ${row.id} and state = 'purging'`;
      }
    }
  }

  await recordMaintenanceAudit(db, operator, "storage.purge_batch", {
    fileCount: purgedFileCount,
    bytes: purgedBytes,
    skippedCount,
  });
  return { purgedFileCount, purgedBytes, skippedCount, remainingEligibleCount: (await getStorageMaintenanceSummary(operator)).purgeableFileCount };
}
