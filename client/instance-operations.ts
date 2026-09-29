import {
  ApiClient,
  type InstanceLiveResources,
  type InstanceOperationsDatabase,
  type InstanceOperationsOverview,
  type InstanceOperationsSnapshot,
  type InstanceOperationsStorageKind,
  type InstanceOperationsStorageScan,
} from "./api";
import { renderIcons } from "./icons";
import { initializeAdminTheme } from "./instance-admin-theme";
import { initializeAdminDashboard } from "./instance-admin-dashboard";

const api = new ApiClient();
const logoutButton = document.getElementById("admin-logout-operations") as HTMLButtonElement;
const overviewRoot = document.getElementById("instance-overview-groups") as HTMLElement;
const overviewStatus = document.getElementById("instance-overview-status") as HTMLElement;
const overviewRefreshButton = document.getElementById("refresh-instance-overview") as HTMLButtonElement;
const liveMetricsRoot = document.getElementById("instance-live-resource-metrics") as HTMLElement;
const liveChartRoot = document.getElementById("instance-live-resource-chart") as HTMLElement;
const liveStatus = document.getElementById("instance-live-resource-status") as HTMLElement;
const refreshButton = document.getElementById("refresh-instance-operations") as HTMLButtonElement;
const operationsStatus = document.getElementById("instance-operations-status") as HTMLElement;
const operationsAlerts = document.getElementById("instance-operations-alerts") as HTMLElement;
const operationsDashboard = document.getElementById("instance-operations-dashboard") as HTMLElement;

type LiveMetricTarget = { card: HTMLElement; value: HTMLElement; detail: HTMLElement; meter: HTMLElement | null; bar: HTMLElement | null };
let liveTargets: {
  uptime: LiveMetricTarget;
  processCpu: LiveMetricTarget;
  hostCpu: LiveMetricTarget;
  processMemory: LiveMetricTarget;
  hostMemory: LiveMetricTarget;
  loadAverage: LiveMetricTarget;
} | null = null;
let livePollingTimer: number | null = null;
let overviewPollingTimer: number | null = null;
let liveRequestInProgress = false;
let overviewRequestInProgress = false;
let scanInProgress = false;
let latestOverviewAt = 0;
const liveHistory: Array<{ at: number; processCpu: number | null; hostCpu: number | null; hostMemory: number | null }> = [];

type ChartSeries = { name: string; color: string; values: number[] };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string> = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function renderLineChart(
  parent: HTMLElement,
  title: string,
  summary: string,
  labels: string[],
  series: ChartSeries[],
  options: { max?: number; formatter?: (value: number) => string } = {},
) {
  const figure = node("figure", "instance-ops-chart");
  const caption = node("figcaption", "instance-ops-chart-caption");
  caption.append(node("strong", undefined, title), node("span", undefined, summary));
  figure.append(caption);
  const legend = node("div", "instance-ops-chart-legend");
  for (const item of series) {
    const entry = node("span");
    const swatch = node("i");
    swatch.style.setProperty("--chart-series-color", item.color);
    entry.append(swatch, document.createTextNode(item.name));
    legend.append(entry);
  }
  figure.append(legend);

  if (labels.length === 0 || series.every((item) => item.values.length === 0)) {
    figure.append(node("p", "instance-ops-chart-empty", "Trend data is unavailable for this sample."));
    parent.append(figure);
    return;
  }

  const width = 400;
  const height = 196;
  const left = 42;
  const right = 10;
  const top = 13;
  const bottom = 31;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const plotBottom = top + plotHeight;
  const values = series.flatMap((item) => item.values).filter(Number.isFinite);
  const maxValue = options.max ?? Math.max(1, ...values);
  const formatAxis = options.formatter ?? ((value: number) => formatCompactCount(value));
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${title} chart. ${series.map((item) => `${item.name}: latest ${formatCount(item.values[item.values.length - 1] ?? 0)}`).join(". ")}`,
    preserveAspectRatio: "none",
  });
  const accessibleTitle = svgNode("title");
  accessibleTitle.textContent = title;
  const accessibleDescription = svgNode("desc");
  accessibleDescription.textContent = summary;
  svg.append(accessibleTitle, accessibleDescription);

  for (const fraction of [0, 0.5, 1]) {
    const y = top + plotHeight * (1 - fraction);
    svg.append(svgNode("line", { x1: String(left), y1: y.toFixed(1), x2: String(width - right), y2: y.toFixed(1), class: "instance-ops-chart-gridline" }));
    const axisLabel = svgNode("text", { x: String(left - 8), y: (y + 3).toFixed(1), "text-anchor": "end", class: "instance-ops-chart-axis" });
    axisLabel.textContent = formatAxis(maxValue * fraction);
    svg.append(axisLabel);
  }

  const x = (index: number) => left + (labels.length <= 1 ? plotWidth / 2 : (plotWidth * index) / (labels.length - 1));
  const y = (value: number) => top + plotHeight * (1 - Math.max(0, Math.min(maxValue, value)) / maxValue);
  const labelIndexes = labels.length <= 8
    ? labels.map((_, index) => index)
    : [...new Set([0, Math.round((labels.length - 1) / 3), Math.round((labels.length - 1) * 2 / 3), labels.length - 1])];
  for (const index of labelIndexes) {
    const tick = svgNode("text", { x: x(index).toFixed(1), y: String(height - 8), "text-anchor": "middle", class: "instance-ops-chart-axis" });
    tick.textContent = labels[index] ?? "";
    svg.append(tick);
  }

  for (const [seriesIndex, item] of series.entries()) {
    const points = item.values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
    if (series.length === 1 && points) {
      const area = svgNode("path", {
        d: `${points} L${x(item.values.length - 1).toFixed(1)},${plotBottom} L${x(0).toFixed(1)},${plotBottom} Z`,
        fill: item.color,
        "fill-opacity": "0.09",
        class: "instance-ops-chart-area",
      });
      svg.append(area);
    }
    if (points) svg.append(svgNode("path", { d: points, fill: "none", stroke: item.color, "stroke-width": seriesIndex === 0 ? "2.8" : "2.3", "stroke-linecap": "round", "stroke-linejoin": "round", class: "instance-ops-chart-line" }));
    const pointStride = item.values.length > 12 ? Math.ceil(item.values.length / 12) : 1;
    item.values.forEach((value, index) => {
      if (index % pointStride !== 0 && index !== item.values.length - 1) return;
      const circle = svgNode("circle", { cx: x(index).toFixed(1), cy: y(value).toFixed(1), r: item.values.length > 12 ? "2" : "3.5", fill: item.color, class: "instance-ops-chart-point" });
      const pointTitle = svgNode("title");
      pointTitle.textContent = `${labels[index] ?? "Sample"}: ${formatCount(value)} · ${item.name}`;
      circle.append(pointTitle);
      svg.append(circle);
    });
  }

  figure.append(svg);
  parent.append(figure);
}

function formatCompactCount(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return formatCount(value);
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  if (value < 1_000) return `${Math.max(0, Math.round(value))} B`;
  const units = ["kB", "MB", "GB", "TB", "PB"];
  let scaled = value;
  let unit = "B";
  for (const candidate of units) {
    scaled /= 1_000;
    unit = candidate;
    if (scaled < 1_000 || candidate === units[units.length - 1]) break;
  }
  return `${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${unit}`;
}

function formatCount(value: number) {
  return Math.max(0, Math.trunc(value)).toLocaleString();
}

function formatMaybeCount(value: number | null) {
  return value === null ? "Unavailable" : formatCount(value);
}

function formatUptime(seconds: number) {
  const total = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${total % 60}s`;
}

function appendMetric(
  parent: HTMLElement,
  label: string,
  value: string,
  detail: string,
  options: { tone?: "warning" | "danger"; percentage?: number } = {},
) {
  const card = node("article", "instance-ops-card");
  if (options.tone) card.dataset.tone = options.tone;
  card.append(
    node("span", "instance-ops-card-label", label),
    node("strong", undefined, value),
    node("small", undefined, detail),
  );
  if (options.percentage !== undefined) {
    const meter = node("div", "instance-ops-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", label);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", String(Math.round(options.percentage)));
    const bar = node("span");
    bar.style.width = `${Math.max(0, Math.min(100, options.percentage))}%`;
    meter.append(bar);
    card.append(meter);
  }
  parent.append(card);
}

function appendLiveMetric(parent: HTMLElement, label: string, value: string, detail: string, withMeter = false): LiveMetricTarget {
  const card = node("article", "instance-ops-card instance-ops-live-card");
  const valueNode = node("strong", undefined, value);
  const detailNode = node("small", undefined, detail);
  card.append(node("span", "instance-ops-card-label", label), valueNode, detailNode);
  let meter: HTMLElement | null = null;
  let bar: HTMLElement | null = null;
  if (withMeter) {
    meter = node("div", "instance-ops-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", label);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    meter.setAttribute("aria-valuenow", "0");
    bar = node("span");
    meter.append(bar);
    card.append(meter);
  }
  parent.append(card);
  return { card, value: valueNode, detail: detailNode, meter, bar };
}

function setLiveMetric(target: LiveMetricTarget, value: string, detail: string, percentage?: number | null, tone?: "warning" | "danger") {
  target.value.textContent = value;
  target.detail.textContent = detail;
  if (tone) target.card.dataset.tone = tone;
  else delete target.card.dataset.tone;
  if (target.meter && target.bar && percentage !== undefined && percentage !== null) {
    const bounded = Math.max(0, Math.min(100, percentage));
    target.bar.style.width = `${bounded}%`;
    target.meter.setAttribute("aria-valuenow", String(Math.round(bounded)));
  }
}

function formatPercent(value: number | null) {
  return value === null || !Number.isFinite(value) ? "Sampling…" : `${value.toFixed(1)}%`;
}

function updateLiveMetrics(resources: InstanceLiveResources) {
  if (!liveTargets) return;
  const sampledAt = new Date(resources.sampledAt).toLocaleTimeString();
  const interval = resources.intervalMs === null ? "first sample" : `${(resources.intervalMs / 1_000).toFixed(1)}s average`;
  const processTone = resources.appProcessPercent !== null && resources.appProcessPercent >= 80 ? "warning" : undefined;
  const hostTone = resources.hostPercent !== null && resources.hostPercent >= 85 ? "warning" : undefined;
  const memoryTotal = resources.hostMemory.totalBytes;
  const memoryAvailable = resources.hostMemory.availableBytes;
  const memoryUsedPercent = memoryTotal > 0 ? 100 * (memoryTotal - memoryAvailable) / memoryTotal : 0;
  const memoryTone = memoryUsedPercent >= 90 ? "warning" : undefined;

  const sampleTime = new Date(resources.sampledAt);
  if (Number.isFinite(sampleTime.getTime()) && resources.appProcessPercent !== null && resources.hostPercent !== null && memoryTotal > 0) {
    const previous = liveHistory[liveHistory.length - 1];
    if (!previous || previous.at < sampleTime.getTime()) {
      liveHistory.push({
        at: sampleTime.getTime(),
        processCpu: resources.appProcessPercent,
        hostCpu: resources.hostPercent,
        hostMemory: memoryUsedPercent,
      });
      if (liveHistory.length > 60) liveHistory.shift();
    }
    liveChartRoot.replaceChildren();
    const labels = liveHistory.map(({ at }) => new Date(at).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }));
    renderLineChart(liveChartRoot, "Rolling 3-minute resource history", "Up to 3 minutes · one sample every 3 seconds · history is held in this page only", labels, [
      { name: "App CPU", color: "#83b9ff", values: liveHistory.map(({ processCpu }) => processCpu ?? 0) },
      { name: "Host CPU", color: "#c59aff", values: liveHistory.map(({ hostCpu }) => hostCpu ?? 0) },
      { name: "Host memory", color: "#75d7a8", values: liveHistory.map(({ hostMemory }) => hostMemory ?? 0) },
    ], { max: 100, formatter: (value) => `${Math.round(value)}%` });
  }

  setLiveMetric(liveTargets.uptime, formatUptime(resources.uptimeSeconds), `Bun process · updated ${sampledAt}`);
  setLiveMetric(liveTargets.processCpu, formatPercent(resources.appProcessPercent),
    `Normalized across ${resources.logicalCores} logical cores · ${interval}`, resources.appProcessPercent, processTone);
  setLiveMetric(liveTargets.hostCpu, formatPercent(resources.hostPercent),
    `OS-reported across ${resources.logicalCores} logical cores · ${interval}`, resources.hostPercent, hostTone);
  setLiveMetric(liveTargets.processMemory, formatBytes(resources.memory.residentBytes),
    `Heap ${formatBytes(resources.memory.heapUsedBytes)} / ${formatBytes(resources.memory.heapTotalBytes)} · external ${formatBytes(resources.memory.externalBytes)}`);
  setLiveMetric(liveTargets.hostMemory, `${formatBytes(memoryTotal - memoryAvailable)} / ${formatBytes(memoryTotal)}`,
    `${formatBytes(memoryAvailable)} available · OS-reported · updated ${sampledAt}`, memoryUsedPercent, memoryTone);
  setLiveMetric(liveTargets.loadAverage, resources.loadAverage.map((value) => value.toFixed(2)).join(" · "),
    `tasks · 1 min · 5 min · 15 min averages · updated ${sampledAt}`);
  liveStatus.textContent = `Updated ${sampledAt} · next sample in 3 seconds`;
}

function initializeLiveMetrics() {
  liveMetricsRoot.replaceChildren();
  const processCpu = appendLiveMetric(liveMetricsRoot, "App CPU / host capacity", "Sampling…", "Waiting for the next interval", true);
  const hostCpu = appendLiveMetric(liveMetricsRoot, "Host CPU", "Sampling…", "Waiting for the next interval", true);
  const processMemory = appendLiveMetric(liveMetricsRoot, "Process resident memory", "—", "Waiting for sample");
  const hostMemory = appendLiveMetric(liveMetricsRoot, "Host memory", "—", "Waiting for sample", true);
  const uptime = appendLiveMetric(liveMetricsRoot, "Process uptime", "—", "Bun process");
  const loadAverage = appendLiveMetric(liveMetricsRoot, "System load (tasks)", "—", "1 min · 5 min · 15 min averages");
  liveTargets = { uptime, processCpu, hostCpu, processMemory, hostMemory, loadAverage };
}

async function refreshLiveResources() {
  if (document.hidden || !liveTargets || liveRequestInProgress) return;
  liveRequestInProgress = true;
  try {
    updateLiveMetrics(await api.instanceLiveResources());
  } catch {
    liveStatus.textContent = "Live readings unavailable · retrying automatically";
    liveTargets.processCpu.detail.textContent = "Live sample unavailable; retrying automatically";
    liveTargets.hostCpu.detail.textContent = "Live sample unavailable; retrying automatically";
  } finally {
    liveRequestInProgress = false;
  }
}

function startLivePolling() {
  if (document.hidden) return;
  if (livePollingTimer === null) {
    void refreshLiveResources();
    livePollingTimer = window.setInterval(() => void refreshLiveResources(), 3_000);
  }
  if (overviewPollingTimer === null) {
    void loadOverview();
    overviewPollingTimer = window.setInterval(() => void loadOverview(), 30_000);
  }
}

function stopLivePolling() {
  if (livePollingTimer !== null) {
    window.clearInterval(livePollingTimer);
    livePollingTimer = null;
  }
  if (overviewPollingTimer !== null) {
    window.clearInterval(overviewPollingTimer);
    overviewPollingTimer = null;
  }
}

function section(parent: HTMLElement, eyebrow: string, title: string, description?: string) {
  const result = node("section", "instance-admin-panel instance-ops-section");
  const heading = node("header", "instance-ops-section-heading");
  const copy = node("div");
  copy.append(node("p", "eyebrow", eyebrow), node("h3", undefined, title));
  if (description) copy.append(node("p", "instance-ops-note", description));
  heading.append(copy);
  result.append(heading);
  parent.append(result);
  return result;
}

function renderDatabaseCard(parent: HTMLElement, label: string, database: InstanceOperationsDatabase) {
  const card = node("article", "instance-ops-database-card");
  const heading = node("div", "instance-ops-database-heading");
  heading.append(
    node("h4", undefined, label),
    node("span", `instance-ops-db-status${database.status === "available" ? " is-available" : ""}`, database.status === "available" ? "Available" : "Unavailable"),
  );
  card.append(heading, node("strong", undefined, formatBytes(database.sizeBytes)));
  card.append(node("p", undefined, "Total PostgreSQL database size, including indexes."));
  if (database.tables.length > 0) {
    const details = node("details", "instance-ops-tables");
    const summary = node("summary", undefined, `Largest tables · ${database.tables.length}`);
    const list = node("ul", "instance-ops-table-list");
    for (const table of database.tables) {
      const row = node("li");
      row.append(
        node("span", undefined, table.name),
        node("span", undefined, `${formatBytes(table.sizeBytes)} · ~${formatCount(table.estimatedRows)} rows`),
      );
      list.append(row);
    }
    details.append(summary, list);
    card.append(details);
  }
  if (label === "Application database" && Object.keys(database.estimatedRows).length > 0) {
    const inventory = node("div", "instance-ops-inventory");
    inventory.append(node("span", "instance-ops-card-label", "Approximate row counts"));
    const grid = node("div", "instance-ops-metrics instance-ops-inventory-grid");
    const names: Array<[string, string]> = [
      ["users", "Users"], ["servers", "Spaces"], ["channels", "Rooms"],
      ["messages", "Messages"], ["attachments", "Attachments"], ["customEmoji", "Custom emoji"],
    ];
    for (const [key, name] of names) {
      const value = database.estimatedRows[key];
      if (value !== undefined) appendMetric(grid, name, formatCount(value), "PostgreSQL row estimate");
    }
    inventory.append(grid);
    card.append(inventory);
  }
  parent.append(card);
}

function appendFactGroup(parent: HTMLElement, title: string, items: Array<[string, string]>) {
  const group = node("section", "instance-ops-fact-group");
  group.append(node("h3", undefined, title));
  const list = node("dl");
  for (const [label, value] of items) {
    const row = node("div");
    row.append(node("dt", undefined, label), node("dd", undefined, value));
    list.append(row);
  }
  group.append(list);
  parent.append(group);
}

function formatTrendDay(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderOverview(overview: InstanceOperationsOverview) {
  const sampledAt = new Date(overview.generatedAt).getTime();
  if (Number.isFinite(sampledAt) && sampledAt < latestOverviewAt) return false;
  if (Number.isFinite(sampledAt)) latestOverviewAt = sampledAt;

  overviewRoot.replaceChildren();
  const kpis = node("div", "instance-ops-overview-kpis");
  appendMetric(kpis, "Total chat accounts", formatMaybeCount(overview.accounts.totalUsers), "Exact total · host operators excluded");
  appendMetric(kpis, "Authenticated · 24h", formatMaybeCount(overview.accounts.authenticatedUsers24h), "Distinct accounts with a recently used valid session");
  appendMetric(
    kpis,
    "Connected chat users",
    overview.realtime.status === "available" ? formatMaybeCount(overview.realtime.connectedUsers) : overview.realtime.status === "limited" ? "Limited" : "Unavailable",
    overview.realtime.status === "available"
      ? `Distinct users · Redis lease expires in ${overview.realtime.leaseSeconds}s`
      : overview.realtime.status === "limited"
        ? "Distinct-user safety limit reached; socket count remains available"
        : "Redis connection leases are unavailable",
  );
  appendMetric(kpis, "Open WebSockets", formatMaybeCount(overview.realtime.websocketConnections), "Each open tab or device counts as one connection");
  overviewRoot.append(kpis);

  const body = node("div", "instance-ops-overview-body");
  const trends = node("section", "instance-ops-trend-panel");
  const trendsHeader = node("header", "instance-ops-trend-heading");
  trendsHeader.append(node("h3", undefined, "Instance activity · last 7 days"), node("p", undefined, "Daily database-calendar counts. No message or upload content is read."));
  trends.append(trendsHeader);
  const charts = node("div", "instance-ops-trend-charts");
  const trendDays = overview.activity.daily.status === "available" ? overview.activity.daily.days : [];
  const dayLabels = trendDays.map(({ day }) => formatTrendDay(day));
  const registrations = trendDays.map(({ newUsers }) => newUsers);
  const messages = trendDays.map(({ messageEnvelopes }) => messageEnvelopes);
  const uploads = trendDays.map(({ attachmentRecords, customEmojiRecords }) => attachmentRecords + customEmojiRecords);
  const trendTotal = (values: number[]) => `${formatCount(values.reduce((sum, value) => sum + value, 0))} · 7 database days`;
  renderLineChart(charts, "New accounts", trendTotal(registrations), dayLabels, [
    { name: "Accounts", color: "#83b9ff", values: registrations },
  ]);
  renderLineChart(charts, "Message envelopes", trendTotal(messages), dayLabels, [
    { name: "Encrypted records", color: "#c59aff", values: messages },
  ]);
  renderLineChart(charts, "Upload records", trendTotal(uploads), dayLabels, [
    { name: "Attachments + emoji", color: "#75d7a8", values: uploads },
  ]);
  trends.append(charts);
  body.append(trends);

  const facts = node("aside", "instance-ops-facts-panel");
  appendFactGroup(facts, "Growth & devices", [
    ["New accounts · 24h", formatMaybeCount(overview.accounts.newUsers24h)],
    ["New accounts · 7d", formatMaybeCount(overview.accounts.newUsers7d)],
    ["Active devices", formatMaybeCount(overview.accounts.activeDevices)],
  ]);
  appendFactGroup(facts, "Community", [
    ["Spaces", formatMaybeCount(overview.community.spaces)],
    ["Active rooms", formatMaybeCount(overview.community.activeRooms)],
  ]);
  appendFactGroup(facts, "Encrypted records · approximate", [
    ["Message envelopes", formatMaybeCount(overview.activity.messageEnvelopesEstimate)],
    ["Attachment records", formatMaybeCount(overview.activity.attachmentRecordsEstimate)],
    ["Custom emoji records", formatMaybeCount(overview.activity.customEmojiRecordsEstimate)],
  ]);
  const moderationValue = (value: number | null) => overview.moderation.status === "available" ? formatMaybeCount(value) : "Unavailable";
  appendFactGroup(facts, "Moderation", [
    ["Open reports", moderationValue(overview.moderation.openReports)],
    ["Reviewing reports", moderationValue(overview.moderation.reviewingReports)],
    ["Suspended accounts", moderationValue(overview.moderation.suspendedAccounts)],
  ]);
  body.append(facts);
  overviewRoot.append(body);
  overviewRoot.hidden = false;

  const generated = Number.isFinite(sampledAt) ? new Date(sampledAt).toLocaleTimeString() : "just now";
  const partials = [
    overview.appDatabase === "unavailable" ? "application database unavailable" : "",
    overview.realtime.status === "unavailable" ? "concurrent connection counts unavailable" : "",
    overview.realtime.status === "limited" ? "distinct connected-user count limited" : "",
    overview.moderation.status === "unavailable" ? "moderation counts unavailable" : "",
    overview.activity.daily.status === "unavailable" ? "7-day trend data unavailable" : "",
  ].filter(Boolean);
  overviewStatus.dataset.state = partials.length > 0 ? "warning" : "success";
  overviewStatus.textContent = `Updated ${generated}${partials.length > 0 ? ` · ${partials.join(" · ")}` : ""}. Counts are aggregate-only.`;
  return true;
}

async function loadOverview() {
  if (overviewRequestInProgress) return;
  overviewRequestInProgress = true;
  overviewRefreshButton.disabled = true;
  overviewStatus.dataset.state = "loading";
  overviewStatus.textContent = overviewRoot.hidden
    ? "Loading aggregate instance counts…"
    : "Refreshing aggregate counts… The previous sample remains visible.";
  overviewRoot.setAttribute("aria-busy", "true");
  if (!overviewRoot.hidden) overviewRoot.dataset.stale = "true";
  try {
    if (!renderOverview(await api.instanceOperationsOverview())) {
      overviewStatus.dataset.state = "success";
      overviewStatus.textContent = `A newer overview sample is already displayed (${new Date(latestOverviewAt).toLocaleTimeString()}).`;
    }
    delete overviewRoot.dataset.stale;
  } catch {
    overviewStatus.dataset.state = "error";
    overviewStatus.textContent = overviewRoot.hidden
      ? "Unable to load instance counts. Check the operator session and application database."
      : "Refresh failed. The previous overview sample remains visible.";
  } finally {
    overviewRoot.setAttribute("aria-busy", "false");
    overviewRequestInProgress = false;
    overviewRefreshButton.disabled = false;
  }
}

const storageKindLabels: Record<InstanceOperationsStorageKind, string> = {
  attachments: "Message attachments",
  customEmoji: "Custom emoji",
  avatars: "Profile avatars",
  banners: "Profile banners",
  serverBranding: "Space icons and banners",
  shared: "Shared references",
};

const storageWarningLabels: Record<string, string> = {
  entry_limit_reached: "Scan stopped at the safety limit of 200,000 directory entries.",
  reference_limit_reached: "Database references exceeded the safety limit; orphan and missing totals are incomplete.",
  references_unavailable: "Database file references could not be loaded; orphan and missing totals are unavailable.",
  filesystem_capacity_unavailable: "Filesystem capacity could not be measured for this directory.",
  directory_unreadable: "Some directories could not be read; this is a partial scan.",
  file_changed_during_scan: "Some files changed while the scan was running.",
  symlink_ignored: "Symbolic links were skipped for safety.",
  non_file_entry_ignored: "Non-file filesystem entries were skipped.",
};

function renderStorageCard(parent: HTMLElement, title: string, scan: InstanceOperationsStorageScan | null) {
  const card = node("article", "instance-ops-storage-card");
  card.append(node("h4", undefined, title));
  if (!scan) {
    card.append(node("p", undefined, "Storage scan unavailable. Check that the configured storage directories are accessible."));
    parent.append(card);
    return;
  }
  card.append(node("strong", undefined, formatBytes(scan.fileBytes)));
  card.append(node("p", undefined, `${formatCount(scan.fileCount)} files observed · logical file sizes, excluding filesystem metadata`));

  const categories = node("dl", "instance-ops-storage-labels");
  for (const [kind, label] of Object.entries(storageKindLabels) as Array<[InstanceOperationsStorageKind, string]>) {
    const usage = scan.categories[kind];
    if (usage.fileCount === 0) continue;
    const row = node("div");
    row.append(node("dt", undefined, label), node("dd", undefined, `${formatCount(usage.fileCount)} · ${formatBytes(usage.bytes)}`));
    categories.append(row);
  }
  if (categories.childElementCount > 0) card.append(categories);

  const integrity = node("div", "instance-ops-integrity");
  if (scan.quarantinedFileCount > 0) {
    integrity.append(node("span", undefined, `${formatCount(scan.quarantinedFileCount)} files in recovery quarantine · ${formatBytes(scan.quarantinedBytes)}`));
  }
  const orphanDetail = !scan.orphanDetectionAvailable
    ? "Orphan detection unavailable"
    : `${scan.complete ? "" : "Partial scan · "}${formatCount(scan.orphanedFileCount)} likely orphaned${scan.complete ? "" : " observed"} · ${formatBytes(scan.orphanedBytes)}`;
  const orphan = node("span", undefined, orphanDetail);
  if (!scan.orphanDetectionAvailable || !scan.complete || scan.orphanedFileCount > 0) orphan.dataset.tone = "warning";
  integrity.append(orphan, node("span", undefined, `${formatCount(scan.referencedFileCount)} referenced files observed · ${formatBytes(scan.referencedBytes)}`));
  const missing = node("span", undefined, scan.missingFileCount === null
    ? "Missing files not verified (partial scan)"
    : `${formatCount(scan.missingFileCount)} referenced files missing`);
  if (scan.missingFileCount && scan.missingFileCount > 0) missing.dataset.tone = "danger";
  integrity.append(missing);
  if (scan.recentUnreferencedFileCount > 0) {
    const recent = node("span", undefined, `${formatCount(scan.recentUnreferencedFileCount)} new unreferenced files · excluded from orphan count`);
    recent.dataset.tone = "warning";
    integrity.append(recent);
  }
  if (scan.unverifiedFileCount > 0) {
    const unverified = node("span", undefined, `${formatCount(scan.unverifiedFileCount)} files unverified · ${formatBytes(scan.unverifiedBytes)}`);
    unverified.dataset.tone = "warning";
    integrity.append(unverified);
  }
  if (scan.temporaryFileCount > 0) {
    const temporary = node("span", undefined, `${formatCount(scan.staleTemporaryFileCount)} stale uploads >1h · ${formatBytes(scan.staleTemporaryBytes)} · ${formatCount(scan.temporaryFileCount)} temp files total`);
    if (scan.staleTemporaryFileCount > 0) temporary.dataset.tone = "warning";
    integrity.append(temporary);
  }
  card.append(integrity);

  const warnings = scan.warnings.map((warning) => storageWarningLabels[warning] ?? "Some filesystem entries were skipped.");
  if (warnings.length > 0) {
    const list = node("ul", "instance-ops-warning-list");
    for (const warning of new Set(warnings)) list.append(node("li", undefined, warning));
    card.append(list);
  }
  parent.append(card);
}

function renderOperationsAlerts(snapshot: InstanceOperationsSnapshot) {
  const alerts: Array<{ tone?: "warning" | "danger"; title: string; message: string; link?: string }> = [];
  const unavailableServices = Object.entries(snapshot.services)
    .filter(([, state]) => state === "unavailable")
    .map(([service]) => service === "appDatabase" ? "Application PostgreSQL" : service === "adminDatabase" ? "Host admin PostgreSQL" : "Redis / Valkey");
  if (unavailableServices.length > 0) {
    alerts.push({ tone: "danger", title: "Service dependency unavailable", message: `${unavailableServices.join(", ")} could not be reached during this snapshot.` });
  }
  if (snapshot.storage.directoriesOverlap) {
    alerts.push({ tone: "danger", title: "Storage roots overlap", message: "Attachment and profile-media directories overlap. Integrity estimates are suppressed until the storage configuration is corrected." });
  }

  const storageScans: Array<[string, InstanceOperationsStorageScan | null]> = snapshot.storage.directoriesOverlap ? [] : [
    ["Attachments and custom emoji", snapshot.storage.attachmentFiles],
    ["Profile and space media", snapshot.storage.profileMediaFiles],
  ];
  for (const [name, scan] of storageScans) {
    if (!scan) {
      alerts.push({ tone: "warning", title: `${name} scan unavailable`, message: "Storage measurements could not be collected for this location." });
      continue;
    }
    if (scan.missingFileCount !== null && scan.missingFileCount > 0) {
      alerts.push({ tone: "danger", title: `${name}: referenced files are missing`, message: `${formatCount(scan.missingFileCount)} database references did not have a file present during this scan. Recheck the storage mount and application logs.` });
    }
    if (scan.orphanedFileCount > 0) {
      alerts.push({
        tone: "warning",
        title: `${name}: review the orphan estimate`,
        message: `${formatCount(scan.orphanedFileCount)} likely unreferenced files (${formatBytes(scan.orphanedBytes)}) were observed. This is an estimate, not proof; review the separate Maintenance workflow before any quarantine action.`,
        link: "/instance-admin/maintenance",
      });
    }
    if (!scan.complete || !scan.orphanDetectionAvailable) {
      alerts.push({ tone: "warning", title: `${name}: integrity scan is incomplete`, message: "Some totals could not be verified. Resolve the listed scan warnings before relying on the estimate." });
    }
    if (scan.unverifiedFileCount > 0) {
      alerts.push({ tone: "warning", title: `${name}: some files were unverified`, message: `${formatCount(scan.unverifiedFileCount)} files (${formatBytes(scan.unverifiedBytes)}) could not be confidently matched to known storage references and are excluded from the orphan estimate.` });
    }
    if (scan.staleTemporaryFileCount > 0) {
      alerts.push({ tone: "warning", title: `${name}: stale temporary uploads observed`, message: `${formatCount(scan.staleTemporaryFileCount)} temporary files older than one hour were observed. Operations does not remove temporary files.` });
    }
  }

  operationsAlerts.replaceChildren();
  for (const alert of alerts) {
    const item = node("article", "instance-ops-alert");
    item.dataset.tone = alert.tone ?? "ok";
    item.append(node("span", undefined, alert.tone === "danger" ? "!" : alert.tone === "warning" ? "·" : "✓"));
    const copy = node("div");
    copy.append(node("strong", undefined, alert.title), node("p", undefined, alert.message));
    if (alert.link) {
      const link = node("a", "text-link", "Open Maintenance");
      link.href = alert.link;
      link.setAttribute("aria-label", "Review storage estimates on the separate Maintenance page");
      copy.append(link);
    }
    item.append(copy);
    operationsAlerts.append(item);
  }
  if (alerts.length === 0) {
    const item = node("article", "instance-ops-alert");
    item.dataset.tone = "ok";
    item.append(node("span", undefined, "✓"));
    const copy = node("div");
    copy.append(node("strong", undefined, "No blocking issues detected"), node("p", undefined, "All monitored dependencies responded and the current storage scans completed without missing-file or orphan estimates."));
    item.append(copy);
    operationsAlerts.append(item);
  }
  operationsAlerts.hidden = false;
}

function renderOperations(snapshot: InstanceOperationsSnapshot) {
  operationsDashboard.replaceChildren();
  renderOperationsAlerts(snapshot);
  const services = section(operationsDashboard, "DEPENDENCIES", "Service health");
  const serviceGrid = node("div", "instance-ops-services");
  const serviceLabels: Array<[string, "available" | "unavailable"]> = [
    ["Application PostgreSQL", snapshot.services.appDatabase],
    ["Admin PostgreSQL", snapshot.services.adminDatabase],
    ["Redis / Valkey", snapshot.services.redis],
  ];
  for (const [label, state] of serviceLabels) {
    const item = node("div", "instance-ops-service");
    item.dataset.status = state;
    item.append(node("strong", undefined, label), node("span", undefined, state === "available" ? "Available" : "Unavailable"));
    serviceGrid.append(item);
  }
  services.append(serviceGrid);

  const databaseSection = section(operationsDashboard, "DATABASES", "PostgreSQL footprint", "Database and table sizes are live measurements. Row counts are PostgreSQL statistics estimates and may lag recent writes.");
  const databaseGrid = node("div", "instance-ops-database-grid");
  renderDatabaseCard(databaseGrid, "Application database", snapshot.databases.app);
  renderDatabaseCard(databaseGrid, "Host admin database", snapshot.databases.admin);
  databaseSection.append(databaseGrid);

  const storage = section(operationsDashboard, "FILE STORAGE", "Storage and integrity", "Directory scans are read-only. Likely orphans are older than one hour; newer unreferenced files are shown separately to avoid upload/update races.");
  if (snapshot.storage.directoriesOverlap) {
    const warning = node("p", "instance-ops-warning", "The configured attachment and profile-media directories overlap. Separate ATTACHMENTS_DIR and PROFILE_IMAGES_DIR before scanning integrity to avoid misleading orphan results.");
    warning.setAttribute("role", "note");
    storage.append(warning);
  } else {
    if (!snapshot.storage.available) {
      storage.append(node("p", "instance-ops-note", "Database references are unavailable. File sizes are still scanned, but orphan and missing-file totals are not verified."));
    }
    const storageGrid = node("div", "instance-ops-storage-grid");
    renderStorageCard(storageGrid, "Attachments & custom emoji", snapshot.storage.attachmentFiles);
    renderStorageCard(storageGrid, "Profile & space media", snapshot.storage.profileMediaFiles);
    storage.append(storageGrid);

  const volumes = [
    ["Attachments", snapshot.storage.attachmentFiles],
    ["Profile media", snapshot.storage.profileMediaFiles],
  ] as Array<[string, InstanceOperationsStorageScan | null]>;
  const measurableVolumes = volumes.filter((entry): entry is [string, InstanceOperationsStorageScan] => Boolean(entry[1]?.volume));
  if (measurableVolumes.length > 0) {
    const volumeGrid = node("div", "instance-ops-metrics instance-ops-volume-grid");
    const sameFilesystem = measurableVolumes.length === 2
      && measurableVolumes[0][1].volume?.totalBytes === measurableVolumes[1][1].volume?.totalBytes
      && measurableVolumes[0][1].volume?.availableBytes === measurableVolumes[1][1].volume?.availableBytes;
    if (sameFilesystem) {
      const volume = measurableVolumes[0][1].volume!;
      appendMetric(
        volumeGrid,
        "Shared storage filesystem",
        `${formatBytes(volume.availableBytes)} free`,
        `${formatBytes(volume.totalBytes)} total capacity · both configured storage roots report the same filesystem`,
        { percentage: volume.totalBytes > 0 ? 100 * (volume.totalBytes - volume.availableBytes) / volume.totalBytes : 0 },
      );
    } else {
      for (const [label, scan] of measurableVolumes) {
        const volume = scan.volume!;
        appendMetric(
          volumeGrid,
          `${label} filesystem capacity`,
          `${formatBytes(volume.availableBytes)} free`,
          `${formatBytes(volume.totalBytes)} total capacity for this storage path's filesystem`,
          { percentage: volume.totalBytes > 0 ? 100 * (volume.totalBytes - volume.availableBytes) / volume.totalBytes : 0 },
        );
      }
    }
      storage.append(volumeGrid);
    }
  }

  operationsDashboard.hidden = false;
  delete operationsDashboard.dataset.stale;
  const generated = new Date(snapshot.generatedAt);
  operationsStatus.dataset.state = "success";
  operationsStatus.textContent = `Snapshot completed ${Number.isNaN(generated.getTime()) ? "just now" : generated.toLocaleString()}. No files were cleaned up and no moderation actions were taken.`;
}

async function loadOperations() {
  if (scanInProgress) return;
  scanInProgress = true;
  refreshButton.disabled = true;
  operationsStatus.dataset.state = "loading";
  operationsStatus.textContent = operationsDashboard.hidden
    ? "Collecting service, database, and filesystem measurements…"
    : "Refreshing the on-demand snapshot… The previous snapshot remains visible until this finishes.";
  operationsDashboard.setAttribute("aria-busy", "true");
  if (!operationsDashboard.hidden) operationsDashboard.dataset.stale = "true";
  try {
    renderOperations(await api.instanceOperations());
  } catch {
    operationsStatus.dataset.state = "error";
    operationsStatus.textContent = operationsDashboard.hidden
      ? "Unable to collect the operations snapshot. Check service connectivity and try again."
      : "Refresh failed. The previous snapshot is still shown; its timestamp identifies when it was collected.";
  } finally {
    scanInProgress = false;
    refreshButton.disabled = false;
    operationsDashboard.setAttribute("aria-busy", "false");
    if (operationsStatus.dataset.state === "error" && !operationsDashboard.hidden) operationsDashboard.dataset.stale = "true";
  }
}

refreshButton.addEventListener("click", () => void loadOperations());
overviewRefreshButton.addEventListener("click", () => void loadOverview());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopLivePolling();
  else startLivePolling();
});
logoutButton.addEventListener("click", async () => {
  stopLivePolling();
  logoutButton.disabled = true;
  try {
    await api.adminLogout();
    window.location.assign("/instance-admin");
  } catch {
    logoutButton.disabled = false;
  }
});

initializeAdminTheme();
renderIcons(document);
void initializeAdminDashboard(api).catch((error) => console.error("Unable to load operator identity", error));
initializeLiveMetrics();
startLivePolling();
