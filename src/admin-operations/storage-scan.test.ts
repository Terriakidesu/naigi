import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStorageDirectory, type StorageReference } from "./storage-scan";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStorageDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "naigi-storage-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeOldFile(path: string, contents: string, now: number) {
  await writeFile(path, contents);
  const date = new Date(now - 2 * 60 * 60 * 1_000);
  await utimes(path, date, date);
}

describe("host operations storage scan", () => {
  test("separates referenced files, aged orphans, fresh files, missing references, and temp uploads", async () => {
    const directory = await makeStorageDirectory();
    const now = Date.now();
    const referencedKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin";
    const pendingKey = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.bin";
    const orphanKey = "cccccccc-cccc-4ccc-8ccc-cccccccccccc.bin";
    const freshKey = "dddddddd-dddd-4ddd-8ddd-dddddddddddd.bin";
    const staleTempKey = `${"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.bin"}.ffffffff-ffff-4fff-8fff-ffffffffffff.upload`;
    const references: StorageReference[] = [
      { storageKey: referencedKey, kind: "attachments", expectedOnDisk: true },
      { storageKey: pendingKey, kind: "customEmoji", expectedOnDisk: false },
      { storageKey: "99999999-9999-4999-8999-999999999999.bin", kind: "attachments", expectedOnDisk: true },
    ];

    await writeFile(join(directory, referencedKey), "ciphertext");
    await writeFile(join(directory, pendingKey), "pending upload bytes");
    await makeOldFile(join(directory, orphanKey), "leftover bytes", now);
    await writeFile(join(directory, freshKey), "fresh upload");
    await makeOldFile(join(directory, staleTempKey), "temporary", now);

    const result = await scanStorageDirectory(directory, references, { now });

    expect(result.complete).toBe(true);
    expect(result.fileCount).toBe(5);
    expect(result.referencedFileCount).toBe(2);
    expect(result.categories.attachments.fileCount).toBe(1);
    expect(result.categories.customEmoji.fileCount).toBe(1);
    expect(result.orphanedFileCount).toBe(1);
    expect(result.recentUnreferencedFileCount).toBe(1);
    expect(result.missingFileCount).toBe(1);
    expect(result.temporaryFileCount).toBe(1);
    expect(result.staleTemporaryFileCount).toBe(1);
  });

  test("does not make orphan or missing claims when references are unavailable or truncated", async () => {
    const directory = await makeStorageDirectory();
    const now = Date.now();
    await makeOldFile(join(directory, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.bin"), "old bytes", now);

    const unavailable = await scanStorageDirectory(directory, [], {
      now,
      referenceListAvailable: false,
    });
    const truncated = await scanStorageDirectory(directory, [], {
      now,
      referenceListComplete: false,
    });

    expect(unavailable.complete).toBe(false);
    expect(unavailable.orphanedFileCount).toBe(0);
    expect(unavailable.missingFileCount).toBe(null);
    expect(unavailable.unverifiedFileCount).toBe(1);
    expect(unavailable.recentUnreferencedFileCount).toBe(0);
    expect(unavailable.warnings).toContain("references_unavailable");
    expect(truncated.orphanedFileCount).toBe(0);
    expect(truncated.missingFileCount).toBe(null);
    expect(truncated.unverifiedFileCount).toBe(1);
    expect(truncated.warnings).toContain("reference_limit_reached");
  });

  test("skips symbolic links and marks the scan incomplete instead of following them", async () => {
    const directory = await makeStorageDirectory();
    const outside = join(await makeStorageDirectory(), "outside.bin");
    await writeFile(outside, "must not be counted through the link");
    await symlink(outside, join(directory, "linked.bin"));

    const result = await scanStorageDirectory(directory, []);

    expect(result.complete).toBe(false);
    expect(result.fileCount).toBe(0);
    expect(result.fileBytes).toBe(0);
    expect(result.warnings).toContain("symlink_ignored");
  });

  test("reports old orphan candidates only through an internal callback and ignores the reserved quarantine directory", async () => {
    const directory = await makeStorageDirectory();
    const now = Date.now();
    const oldKey = "abababab-abab-4bab-8bab-abababababab.bin";
    await makeOldFile(join(directory, oldKey), "orphan", now - 24 * 60 * 60 * 1_000);
    await mkdir(join(directory, ".naigi-quarantine"));
    await makeOldFile(join(directory, ".naigi-quarantine", "retained.bin"), "retained", now);
    const candidates: Array<{ storageKey: string; sizeBytes: number }> = [];

    const result = await scanStorageDirectory(directory, [], {
      now,
      onOrphanCandidate: ({ storageKey, sizeBytes }) => candidates.push({ storageKey, sizeBytes }),
    });

    expect(result.complete).toBe(true);
    expect(result.fileCount).toBe(2);
    expect(result.quarantinedFileCount).toBe(1);
    expect(result.orphanedFileCount).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.storageKey).toBe(oldKey);
    expect(result).not.toHaveProperty("storageKey");
  });

  test("marks unsafe entries in the reserved quarantine directory incomplete", async () => {
    const directory = await makeStorageDirectory();
    const outside = join(await makeStorageDirectory(), "outside.bin");
    const quarantine = join(directory, ".naigi-quarantine");
    await writeFile(outside, "must not be followed");
    await mkdir(quarantine);
    await symlink(outside, join(quarantine, "linked.bin"));

    const result = await scanStorageDirectory(directory, []);

    expect(result.complete).toBe(false);
    expect(result.quarantinedFileCount).toBe(0);
    expect(result.warnings).toContain("symlink_ignored");
  });
});
