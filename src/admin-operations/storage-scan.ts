import { lstat, opendir, stat, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const storageKinds = [
  "attachments",
  "customEmoji",
  "avatars",
  "banners",
  "serverBranding",
] as const;

export type StorageKind = typeof storageKinds[number];
export type StorageReference = {
  storageKey: string;
  kind: StorageKind;
  expectedOnDisk: boolean;
};

export type StorageScanWarning =
  | "entry_limit_reached"
  | "reference_limit_reached"
  | "references_unavailable"
  | "filesystem_capacity_unavailable"
  | "directory_unreadable"
  | "file_changed_during_scan"
  | "symlink_ignored"
  | "non_file_entry_ignored";

export type StorageScan = {
  complete: boolean;
  orphanDetectionAvailable: boolean;
  scannedEntries: number;
  fileCount: number;
  fileBytes: number;
  quarantinedFileCount: number;
  quarantinedBytes: number;
  referencedFileCount: number;
  referencedBytes: number;
  orphanedFileCount: number;
  orphanedBytes: number;
  recentUnreferencedFileCount: number;
  recentUnreferencedBytes: number;
  unverifiedFileCount: number;
  unverifiedBytes: number;
  missingFileCount: number | null;
  temporaryFileCount: number;
  temporaryBytes: number;
  staleTemporaryFileCount: number;
  staleTemporaryBytes: number;
  categories: Record<StorageKind | "shared", { fileCount: number; bytes: number }>;
  volume: { totalBytes: number; availableBytes: number } | null;
  warnings: StorageScanWarning[];
};

export type OrphanCandidate = {
  storageKey: string;
  sizeBytes: number;
  mtimeMs: number;
  device: number;
  inode: number;
};

const maximumEntries = 200_000;
const staleAfterMs = 60 * 60 * 1_000;
const orphanGraceMs = 60 * 60 * 1_000;

type MutableUsage = { fileCount: number; bytes: number };
type ReferenceSummary = { kinds: Set<StorageKind>; expectedOnDisk: boolean };

function emptyUsage(): MutableUsage {
  return { fileCount: 0, bytes: 0 };
}

function emptyCategories(): StorageScan["categories"] {
  return {
    attachments: emptyUsage(),
    customEmoji: emptyUsage(),
    avatars: emptyUsage(),
    banners: emptyUsage(),
    serverBranding: emptyUsage(),
    shared: emptyUsage(),
  };
}

function safeBytes(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Math.max(0, Math.trunc(value));
}

async function filesystemCapacity(path: string) {
  let current = resolve(path);
  while (true) {
    let info;
    try {
      info = await stat(current);
    } catch (error) {
      if (!ignoredError(error)) return null;
    }
    if (info?.isDirectory()) {
      try {
        const fs = await statfs(current);
        return {
          totalBytes: safeBytes(fs.blocks * fs.bsize),
          availableBytes: safeBytes(fs.bavail * fs.bsize),
        };
      } catch {
        return null;
      }
    }
    if (info) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function ignoredError(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: string }).code === "ENOENT"
    : false;
}

export async function scanStorageDirectory(
  directory: string,
  references: StorageReference[],
  options: {
    now?: number;
    referenceListComplete?: boolean;
    referenceListAvailable?: boolean;
    onOrphanCandidate?: (candidate: OrphanCandidate) => void;
  } = {},
): Promise<StorageScan> {
  const now = options.now ?? Date.now();
  const referenceListComplete = options.referenceListComplete ?? true;
  const referenceListAvailable = options.referenceListAvailable ?? true;
  const referenceMap = new Map<string, ReferenceSummary>();
  for (const reference of references) {
    const existing = referenceMap.get(reference.storageKey) ?? {
      kinds: new Set<StorageKind>(),
      expectedOnDisk: false,
    };
    existing.kinds.add(reference.kind);
    existing.expectedOnDisk ||= reference.expectedOnDisk;
    referenceMap.set(reference.storageKey, existing);
  }

  const warnings = new Set<StorageScanWarning>();
  const seenReferences = new Set<string>();
  const categories = emptyCategories();
  const volume = await filesystemCapacity(directory);
  if (!volume) warnings.add("filesystem_capacity_unavailable");
  const result: StorageScan = {
    complete: referenceListAvailable && referenceListComplete,
    orphanDetectionAvailable: referenceListAvailable && referenceListComplete,
    scannedEntries: 0,
    fileCount: 0,
    fileBytes: 0,
    quarantinedFileCount: 0,
    quarantinedBytes: 0,
    referencedFileCount: 0,
    referencedBytes: 0,
    orphanedFileCount: 0,
    orphanedBytes: 0,
    recentUnreferencedFileCount: 0,
    recentUnreferencedBytes: 0,
    unverifiedFileCount: 0,
    unverifiedBytes: 0,
    missingFileCount: null,
    temporaryFileCount: 0,
    temporaryBytes: 0,
    staleTemporaryFileCount: 0,
    staleTemporaryBytes: 0,
    categories,
    volume,
    warnings: [],
  };
  if (!referenceListAvailable) warnings.add("references_unavailable");
  else if (!referenceListComplete) warnings.add("reference_limit_reached");

  async function walk() {
    let handle;
    try {
      handle = await opendir(resolve(directory));
    } catch (error) {
      if (ignoredError(error)) return;
      warnings.add("directory_unreadable");
      result.complete = false;
      return;
    }

    async function countQuarantinedFiles(path: string) {
      let quarantineHandle;
      try {
        quarantineHandle = await opendir(path);
      } catch (error) {
        warnings.add(ignoredError(error) ? "file_changed_during_scan" : "directory_unreadable");
        result.complete = false;
        return;
      }
      try {
        for await (const entry of quarantineHandle) {
          result.scannedEntries += 1;
          if (result.scannedEntries > maximumEntries) {
            warnings.add("entry_limit_reached");
            result.complete = false;
            break;
          }
          if (entry.isSymbolicLink()) {
            warnings.add("symlink_ignored");
            result.complete = false;
            continue;
          }
          if (!entry.isFile()) {
            warnings.add("non_file_entry_ignored");
            result.complete = false;
            continue;
          }
          try {
            const info = await lstat(join(path, entry.name));
            if (!info.isFile() || info.isSymbolicLink()) {
              warnings.add(info.isSymbolicLink() ? "symlink_ignored" : "non_file_entry_ignored");
              result.complete = false;
              continue;
            }
            const bytes = safeBytes(info.size);
            result.fileCount += 1;
            result.fileBytes += bytes;
            result.quarantinedFileCount += 1;
            result.quarantinedBytes += bytes;
          } catch {
            warnings.add("file_changed_during_scan");
            result.complete = false;
          }
        }
      } catch {
        warnings.add("directory_unreadable");
        result.complete = false;
      }
    }

    async function processFile(path: string) {
      let info;
      try {
        info = await lstat(path);
      } catch {
        warnings.add("file_changed_during_scan");
        result.complete = false;
        return;
      }
      if (!info.isFile()) {
        warnings.add(info.isSymbolicLink() ? "symlink_ignored" : "non_file_entry_ignored");
        result.complete = false;
        return;
      }
      const bytes = safeBytes(info.size);
      result.fileCount += 1;
      result.fileBytes += bytes;
      const key = basename(path);
      const ageMs = Math.max(0, now - info.mtimeMs);
      if (key.endsWith(".upload")) {
        result.temporaryFileCount += 1;
        result.temporaryBytes += bytes;
        if (ageMs >= staleAfterMs) {
          result.staleTemporaryFileCount += 1;
          result.staleTemporaryBytes += bytes;
        }
        return;
      }

      const reference = referenceMap.get(key);
      if (reference) {
        seenReferences.add(key);
        result.referencedFileCount += 1;
        result.referencedBytes += bytes;
        const category = reference.kinds.size === 1 ? [...reference.kinds][0]! : "shared";
        categories[category].fileCount += 1;
        categories[category].bytes += bytes;
      } else if (!referenceListAvailable || !referenceListComplete) {
        result.unverifiedFileCount += 1;
        result.unverifiedBytes += bytes;
      } else if (ageMs >= orphanGraceMs) {
        result.orphanedFileCount += 1;
        result.orphanedBytes += bytes;
        options.onOrphanCandidate?.({
          storageKey: key,
          sizeBytes: bytes,
          mtimeMs: info.mtimeMs,
          device: info.dev,
          inode: info.ino,
        });
      } else {
        result.recentUnreferencedFileCount += 1;
        result.recentUnreferencedBytes += bytes;
      }
    }

    let pendingFiles: string[] = [];
    const flushFiles = async () => {
      const batch = pendingFiles;
      pendingFiles = [];
      await Promise.all(batch.map(processFile));
    };

    try {
      for await (const entry of handle) {
        result.scannedEntries += 1;
        if (result.scannedEntries > maximumEntries) {
          warnings.add("entry_limit_reached");
          result.complete = false;
          break;
        }
        if (entry.isSymbolicLink()) {
          warnings.add("symlink_ignored");
          result.complete = false;
        } else if (entry.isDirectory() && entry.name === ".naigi-quarantine") {
          await countQuarantinedFiles(join(resolve(directory), entry.name));
        } else if (entry.isFile()) {
          pendingFiles.push(join(resolve(directory), entry.name));
          if (pendingFiles.length >= 64) await flushFiles();
        } else {
          warnings.add("non_file_entry_ignored");
          result.complete = false;
        }
      }
    } catch {
      warnings.add("directory_unreadable");
      result.complete = false;
    }
    await flushFiles();
  }

  await walk();
  result.missingFileCount = result.complete
    ? [...referenceMap].filter(([key, reference]) => reference.expectedOnDisk && !seenReferences.has(key)).length
    : null;
  result.warnings = [...warnings];
  return result;
}
