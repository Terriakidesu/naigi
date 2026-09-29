import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { adminDb } from "../admin-db/client";
import { config } from "../config";
import { db } from "../db/client";
import { pingRedis } from "../redis/client";
import { scanStorageDirectory, type StorageKind, type StorageReference, type StorageScan } from "./storage-scan";
import { getLiveConnectionCounts } from "./live-connections";

const maximumReferences = 200_000;
const hostCapacity = cpus().length || 1;

type HostCpuTimes = { user: number; nice: number; sys: number; idle: number; irq: number };
type LiveResourceSample = {
  sampledAt: number;
  processCpu: NodeJS.CpuUsage;
  hostCpu: HostCpuTimes[];
};

let previousLiveResourceSample: LiveResourceSample | undefined;

type SqlConnection = typeof db;
type DatabaseTableUsage = { name: string; sizeBytes: number; estimatedRows: number };
type DatabaseUsage = {
  status: "available" | "unavailable";
  sizeBytes: number | null;
  tables: DatabaseTableUsage[];
  estimatedRows: Record<string, number>;
};
type InstanceOverviewCoreRow = {
  total_users: string;
  authenticated_users_24h: string;
  new_users_24h: string;
  new_users_7d: string;
  active_devices: string;
  spaces: string;
  active_rooms: string;
  messages_estimate: string;
  attachments_estimate: string;
  custom_emoji_estimate: string;
};
type InstanceOverviewModerationRow = {
  open_reports: string;
  reviewing_reports: string;
  suspended_accounts: string;
};
type InstanceActivityTrendRow = {
  day: string;
  new_users: string;
  message_envelopes: string;
  attachment_records: string;
  custom_emoji_records: string;
};

type InstanceActivityTrend = {
  status: "available" | "unavailable";
  days: Array<{
    day: string;
    newUsers: number;
    messageEnvelopes: number;
    attachmentRecords: number;
    customEmojiRecords: number;
  }>;
};

const activityTrendCacheMs = 60_000;
let activityTrendCache: { expiresAt: number; value: InstanceActivityTrend } | undefined;
let activityTrendRequest: Promise<InstanceActivityTrend> | undefined;

export type InstanceOperationsOverview = {
  generatedAt: string;
  appDatabase: "available" | "unavailable";
  accounts: {
    totalUsers: number | null;
    authenticatedUsers24h: number | null;
    newUsers24h: number | null;
    newUsers7d: number | null;
    activeDevices: number | null;
  };
  realtime: Awaited<ReturnType<typeof getLiveConnectionCounts>>;
  community: { spaces: number | null; activeRooms: number | null };
  activity: {
    messageEnvelopesEstimate: number | null;
    attachmentRecordsEstimate: number | null;
    customEmojiRecordsEstimate: number | null;
    daily: InstanceActivityTrend;
  };
  moderation: {
    status: "available" | "unavailable";
    openReports: number | null;
    reviewingReports: number | null;
    suspendedAccounts: number | null;
  };
};

export type StorageReferences = {
  attachmentFiles: StorageReference[];
  profileMediaFiles: StorageReference[];
  attachmentFilesComplete: boolean;
  profileMediaFilesComplete: boolean;
};

function safeInteger(value: number | string | bigint) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function unavailableDatabase(): DatabaseUsage {
  return { status: "unavailable", sizeBytes: null, tables: [], estimatedRows: {} };
}

function overviewCount(value: string | undefined) {
  return value === undefined ? null : safeInteger(value);
}

async function loadActivityTrend(): Promise<InstanceActivityTrend> {
  const rows = await db<InstanceActivityTrendRow[]>`
    with day_range as (
      select date_trunc('day', now()) - interval '6 days' as first_day,
        date_trunc('day', now()) as last_day
    ),
    days as (
      select generate_series(first_day, last_day, interval '1 day')::date as day
      from day_range
    ),
    daily_new_users as (
      select created_at::date as day, count(*)::text as count
      from users, day_range
      where created_at >= first_day and created_at < last_day + interval '1 day'
      group by created_at::date
    ),
    daily_messages as (
      select created_at::date as day, count(*)::text as count
      from messages, day_range
      where created_at >= first_day and created_at < last_day + interval '1 day'
      group by created_at::date
    ),
    daily_attachments as (
      select created_at::date as day, count(*)::text as count
      from attachments, day_range
      where created_at >= first_day and created_at < last_day + interval '1 day'
      group by created_at::date
    ),
    daily_custom_emoji as (
      select created_at::date as day, count(*)::text as count
      from server_custom_emojis, day_range
      where created_at >= first_day and created_at < last_day + interval '1 day'
      group by created_at::date
    )
    select to_char(days.day, 'YYYY-MM-DD') as day,
      coalesce(daily_new_users.count, '0') as new_users,
      coalesce(daily_messages.count, '0') as message_envelopes,
      coalesce(daily_attachments.count, '0') as attachment_records,
      coalesce(daily_custom_emoji.count, '0') as custom_emoji_records
    from days
    left join daily_new_users using (day)
    left join daily_messages using (day)
    left join daily_attachments using (day)
    left join daily_custom_emoji using (day)
    order by days.day
  `;
  return {
    status: "available",
    days: rows.map((row) => ({
      day: row.day,
      newUsers: safeInteger(row.new_users),
      messageEnvelopes: safeInteger(row.message_envelopes),
      attachmentRecords: safeInteger(row.attachment_records),
      customEmojiRecords: safeInteger(row.custom_emoji_records),
    })),
  };
}

function getActivityTrend() {
  const now = Date.now();
  if (activityTrendCache && activityTrendCache.expiresAt > now) return Promise.resolve(activityTrendCache.value);
  activityTrendRequest ??= loadActivityTrend()
    .catch((): InstanceActivityTrend => ({ status: "unavailable", days: [] }))
    .then((value) => {
      activityTrendCache = { expiresAt: Date.now() + activityTrendCacheMs, value };
      return value;
    })
    .finally(() => { activityTrendRequest = undefined; });
  return activityTrendRequest;
}

async function collectInstanceOperationsOverview(): Promise<InstanceOperationsOverview> {
  const [core, realtime, moderation, daily] = await Promise.all([
    db<InstanceOverviewCoreRow[]>`
      with user_counts as (
        select
          count(*)::text as total_users,
          (count(*) filter (where created_at >= now() - interval '24 hours'))::text as new_users_24h,
          (count(*) filter (where created_at >= now() - interval '7 days'))::text as new_users_7d
        from users
      ),
      active_users as (
        select count(distinct user_id)::text as authenticated_users_24h
        from sessions
        where expires_at > now() and last_used_at >= now() - interval '24 hours'
      ),
      community_counts as (
        select
          (select count(*)::text from servers) as spaces,
          (select count(*)::text from channels where archived_at is null) as active_rooms,
          (select count(*)::text from devices where revoked_at is null) as active_devices
      ),
      activity_estimates as (
        select
          coalesce(max(n_live_tup) filter (where relname = 'messages'), 0)::text as messages_estimate,
          coalesce(max(n_live_tup) filter (where relname = 'attachments'), 0)::text as attachments_estimate,
          coalesce(max(n_live_tup) filter (where relname = 'server_custom_emojis'), 0)::text as custom_emoji_estimate
        from pg_stat_user_tables
        where schemaname = current_schema()
      )
      select u.total_users, a.authenticated_users_24h, u.new_users_24h, u.new_users_7d,
        c.active_devices, c.spaces, c.active_rooms,
        x.messages_estimate, x.attachments_estimate, x.custom_emoji_estimate
      from user_counts u cross join active_users a cross join community_counts c cross join activity_estimates x
    `.then((rows) => rows[0] ?? null).catch(() => null),
    getLiveConnectionCounts(),
    db<InstanceOverviewModerationRow[]>`
      select
        (count(*) filter (where status = 'open'))::text as open_reports,
        (count(*) filter (where status = 'reviewing'))::text as reviewing_reports,
        (select count(*)::text from instance_user_suspensions) as suspended_accounts
      from instance_reports
    `.then((rows) => rows[0] ?? null).catch(() => null),
    getActivityTrend(),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    appDatabase: core ? "available" : "unavailable",
    accounts: {
      totalUsers: overviewCount(core?.total_users),
      authenticatedUsers24h: overviewCount(core?.authenticated_users_24h),
      newUsers24h: overviewCount(core?.new_users_24h),
      newUsers7d: overviewCount(core?.new_users_7d),
      activeDevices: overviewCount(core?.active_devices),
    },
    realtime,
    community: {
      spaces: overviewCount(core?.spaces),
      activeRooms: overviewCount(core?.active_rooms),
    },
    activity: {
      messageEnvelopesEstimate: overviewCount(core?.messages_estimate),
      attachmentRecordsEstimate: overviewCount(core?.attachments_estimate),
      customEmojiRecordsEstimate: overviewCount(core?.custom_emoji_estimate),
      daily,
    },
    moderation: moderation
      ? {
        status: "available",
        openReports: overviewCount(moderation.open_reports),
        reviewingReports: overviewCount(moderation.reviewing_reports),
        suspendedAccounts: overviewCount(moderation.suspended_accounts),
      }
      : { status: "unavailable", openReports: null, reviewingReports: null, suspendedAccounts: null },
  };
}

export function getInstanceOperationsOverview() {
  return collectInstanceOperationsOverview();
}

async function databaseUsage(connection: SqlConnection, includeInventory: boolean): Promise<DatabaseUsage> {
  const [database] = await connection<{ size_bytes: string }[]>`
    select pg_database_size(current_database())::text as size_bytes
  `;
  const tables = await connection<{ name: string; size_bytes: string; estimated_rows: string }[]>`
    select relname as name,
      sum(pg_total_relation_size(relid))::text as size_bytes,
      sum(greatest(coalesce(n_live_tup, 0), 0))::text as estimated_rows
    from pg_stat_user_tables
    where schemaname = current_schema()
    group by relname
    order by sum(pg_total_relation_size(relid)) desc
    limit 12
  `;

  let estimatedRows: Record<string, number> = {};
  if (includeInventory) {
    const [rows] = await connection<{
      users: string;
      servers: string;
      channels: string;
      messages: string;
      attachments: string;
      custom_emoji: string;
    }[]>`
      select
        coalesce(max(n_live_tup) filter (where relname = 'users'), 0)::text as users,
        coalesce(max(n_live_tup) filter (where relname = 'servers'), 0)::text as servers,
        coalesce(max(n_live_tup) filter (where relname = 'channels'), 0)::text as channels,
        coalesce(max(n_live_tup) filter (where relname = 'messages'), 0)::text as messages,
        coalesce(max(n_live_tup) filter (where relname = 'attachments'), 0)::text as attachments,
        coalesce(max(n_live_tup) filter (where relname = 'server_custom_emojis'), 0)::text as custom_emoji
      from pg_stat_user_tables
      where schemaname = current_schema()
    `;
    estimatedRows = {
      users: safeInteger(rows?.users ?? 0),
      servers: safeInteger(rows?.servers ?? 0),
      channels: safeInteger(rows?.channels ?? 0),
      messages: safeInteger(rows?.messages ?? 0),
      attachments: safeInteger(rows?.attachments ?? 0),
      customEmoji: safeInteger(rows?.custom_emoji ?? 0),
    };
  }

  return {
    status: "available",
    sizeBytes: safeInteger(database?.size_bytes ?? 0),
    tables: tables.map((table) => ({
      name: table.name,
      sizeBytes: safeInteger(table.size_bytes),
      estimatedRows: safeInteger(table.estimated_rows),
    })),
    estimatedRows,
  };
}

export async function storageReferences(connection: SqlConnection = db): Promise<StorageReferences> {
  const attachmentRows = await connection<{
    storage_key: string;
    kind: StorageKind;
    expected_on_disk: boolean;
  }[]>`
    select storage_key, 'attachments'::text as kind, (status = 'uploaded') as expected_on_disk
    from attachments
    union all
    select storage_key, 'customEmoji'::text as kind, (status = 'uploaded') as expected_on_disk
    from server_custom_emojis
    limit ${maximumReferences + 1}
  `;
  const profileRows = await connection<{
    storage_key: string;
    kind: StorageKind;
    expected_on_disk: boolean;
  }[]>`
    select profile_image_storage_key as storage_key, 'avatars'::text as kind, true as expected_on_disk
    from users where profile_image_storage_key is not null
    union all
    select profile_banner_storage_key as storage_key, 'banners'::text as kind, true as expected_on_disk
    from users where profile_banner_storage_key is not null
    union all
    select icon_storage_key as storage_key, 'serverBranding'::text as kind, true as expected_on_disk
    from servers where icon_storage_key is not null
    union all
    select banner_storage_key as storage_key, 'serverBranding'::text as kind, true as expected_on_disk
    from servers where banner_storage_key is not null
    limit ${maximumReferences + 1}
  `;
  const convert = (rows: typeof attachmentRows) => rows.slice(0, maximumReferences).map((row) => ({
    storageKey: row.storage_key,
    kind: row.kind,
    expectedOnDisk: row.expected_on_disk,
  }));
  return {
    attachmentFiles: convert(attachmentRows),
    profileMediaFiles: convert(profileRows),
    attachmentFilesComplete: attachmentRows.length <= maximumReferences,
    profileMediaFilesComplete: profileRows.length <= maximumReferences,
  };
}

async function settledDatabase(connection: SqlConnection, includeInventory: boolean) {
  try {
    return await databaseUsage(connection, includeInventory);
  } catch {
    return unavailableDatabase();
  }
}

async function settledStorage(
  directory: string,
  references: StorageReference[],
  referenceListComplete: boolean,
  referenceListAvailable: boolean,
) {
  try {
    return await scanStorageDirectory(directory, references, { referenceListComplete, referenceListAvailable });
  } catch {
    return null;
  }
}

async function canonicalStoragePath(path: string) {
  const absolute = resolve(path);
  let current = absolute;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(current), ...missingSegments);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return absolute;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

export async function storageDirectoriesOverlap() {
  const [attachmentsRoot, profileMediaRoot] = await Promise.all([
    canonicalStoragePath(config.attachmentsDirectory),
    canonicalStoragePath(config.profileImagesDirectory),
  ]);
  return attachmentsRoot === profileMediaRoot
    || attachmentsRoot.startsWith(`${profileMediaRoot}${sep}`)
    || profileMediaRoot.startsWith(`${attachmentsRoot}${sep}`);
}

async function collectInstanceOperationsSnapshot() {
  const [appDatabase, adminDatabase, redisAvailable, references] = await Promise.all([
    settledDatabase(db, true),
    settledDatabase(adminDb, false),
    pingRedis().then(() => true).catch(() => false),
    storageReferences().then((value) => value).catch(() => null),
  ]);

  const directoriesOverlap = await storageDirectoriesOverlap();
  const [attachments, profileMedia] = !directoriesOverlap
    ? await Promise.all([
      settledStorage(
        config.attachmentsDirectory,
        references?.attachmentFiles ?? [],
        references?.attachmentFilesComplete ?? false,
        references !== null,
      ),
      settledStorage(
        config.profileImagesDirectory,
        references?.profileMediaFiles ?? [],
        references?.profileMediaFilesComplete ?? false,
        references !== null,
      ),
    ])
    : [null, null];

  const memory = process.memoryUsage();
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      uptimeSeconds: Math.floor(process.uptime()),
      bunVersion: Bun.version,
      memory: {
        residentBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      hostMemory: { totalBytes: totalmem(), availableBytes: freemem() },
      loadAverage: [oneMinute ?? 0, fiveMinutes ?? 0, fifteenMinutes ?? 0],
    },
    services: {
      appDatabase: appDatabase.status,
      adminDatabase: adminDatabase.status,
      redis: redisAvailable ? "available" as const : "unavailable" as const,
    },
    databases: { app: appDatabase, admin: adminDatabase },
    storage: {
      available: references !== null,
      attachmentFiles: attachments,
      profileMediaFiles: profileMedia,
      directoriesOverlap,
    },
  };
}

let activeSnapshot: ReturnType<typeof collectInstanceOperationsSnapshot> | undefined;

export function getInstanceOperationsSnapshot() {
  if (activeSnapshot) return activeSnapshot;
  activeSnapshot = collectInstanceOperationsSnapshot().finally(() => {
    activeSnapshot = undefined;
  });
  return activeSnapshot;
}

export function getInstanceLiveResources() {
  const now = performance.now();
  const processCpu = process.cpuUsage();
  const hostCpu = cpus().map((cpu) => cpu.times);
  const memory = process.memoryUsage();
  let intervalMs: number | null = null;
  let appProcessPercent: number | null = null;
  let hostPercent: number | null = null;

  if (previousLiveResourceSample) {
    const elapsedMs = now - previousLiveResourceSample.sampledAt;
    intervalMs = elapsedMs;
    const processDelta = processCpu.user - previousLiveResourceSample.processCpu.user
      + processCpu.system - previousLiveResourceSample.processCpu.system;
    if (elapsedMs > 0 && processDelta >= 0) {
      appProcessPercent = 100 * processDelta / (elapsedMs * 1_000 * hostCapacity);
    }

    if (hostCpu.length === previousLiveResourceSample.hostCpu.length) {
      let totalDelta = 0;
      let busyDelta = 0;
      for (const [index, current] of hostCpu.entries()) {
        const previous = previousLiveResourceSample.hostCpu[index];
        if (!previous) continue;
        const idle = current.idle - previous.idle;
        const total = current.user - previous.user
          + current.nice - previous.nice
          + current.sys - previous.sys
          + idle
          + current.irq - previous.irq;
        if (idle < 0 || total <= 0) continue;
        totalDelta += total;
        busyDelta += total - idle;
      }
      if (totalDelta > 0) hostPercent = Math.max(0, Math.min(100, 100 * busyDelta / totalDelta));
    }
  }

  previousLiveResourceSample = { sampledAt: now, processCpu, hostCpu };
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  return {
    sampledAt: new Date().toISOString(),
    intervalMs,
    uptimeSeconds: Math.floor(process.uptime()),
    logicalCores: hostCapacity,
    appProcessPercent,
    hostPercent,
    memory: {
      residentBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    hostMemory: { totalBytes: totalmem(), availableBytes: freemem() },
    loadAverage: [oneMinute ?? 0, fiveMinutes ?? 0, fifteenMinutes ?? 0],
  };
}
