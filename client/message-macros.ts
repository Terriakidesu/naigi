export type MessageMacroName =
  | "time"
  | "date"
  | "timestamp"
  | "datetime"
  | "time12"
  | "time24"
  | "relative"
  | "iso"
  | "dateiso"
  | "unix"
  | "epoch"
  | "weekday"
  | "dayofweek"
  | "dayofyear"
  | "month"
  | "day"
  | "year"
  | "hour"
  | "minute"
  | "second"
  | "millisecond"
  | "week"
  | "quarter"
  | "timezone"
  | "zone";

export type ParsedMessageMacro = {
  name: MessageMacroName;
  timestampMs: number;
  format: string;
  hasExplicitFormat: boolean;
  usesNow: boolean;
};

export const MAX_MESSAGE_MACROS = 100;

const minTimestampMs = -62_135_596_800_000;
const maxTimestampMs = 253_402_300_799_999;
const formatters = new Map<string, Intl.DateTimeFormat>();
const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const timestampToken = /\{[a-z][a-z0-9_-]*(?::[^{}\n]*)?\}/gi;
const relativeDurationUnits: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  mo: 2_629_746_000,
  y: 31_556_952_000,
};
const macroNames: MessageMacroName[] = [
  "time", "date", "timestamp", "datetime", "time12", "time24", "relative", "iso", "dateiso",
  "unix", "epoch", "weekday", "dayofweek", "dayofyear", "month", "day", "year", "hour", "minute",
  "second", "millisecond", "week", "quarter", "timezone", "zone",
];

function knownMacro(name: string): name is MessageMacroName {
  return macroNames.includes(name as MessageMacroName);
}

function defaultFormat(name: MessageMacroName) {
  switch (name) {
    case "time": return "t";
    case "date": return "d";
    case "time12": return "12";
    case "time24": return "24";
    case "relative": return "R";
    case "iso": return "I";
    case "dateiso": return "I";
    case "unix":
    case "epoch": return "s";
    case "weekday":
    case "dayofweek":
    case "month": return "long";
    case "day":
    case "year":
    case "hour":
    case "minute":
    case "second":
    case "dayofyear":
    case "week":
    case "quarter": return "numeric";
    case "millisecond": return "3";
    case "timezone":
    case "zone": return "short";
    default: return "f";
  }
}

function validFormat(name: MessageMacroName, format: string) {
  if (["time", "date", "timestamp", "datetime"].includes(name)) {
    return ["t", "T", "d", "D", "f", "F", "R", "I", "U", "s", "ms"].includes(format);
  }
  if (name === "time12") return format === "12";
  if (name === "time24") return format === "24";
  if (["weekday", "dayofweek", "month"].includes(name)) return ["long", "short", "narrow"].includes(format);
  if (["day", "year", "hour", "minute", "second", "dayofyear", "week", "quarter"].includes(name)) {
    return ["numeric", "2-digit", "2", "3"].includes(format) || (name === "hour" && ["12", "24"].includes(format));
  }
  if (name === "millisecond") return format === "3";
  if (name === "timezone" || name === "zone") return format === "short" || format === "long";
  if (name === "relative") return format === "R";
  if (name === "iso" || name === "dateiso") return format === "I";
  if (name === "unix" || name === "epoch") return format === "s" || format === "ms";
  return false;
}

function parseIsoTimestamp(value: string) {
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00)))?$/);
  if (!iso) return undefined;
  const year = Number(iso[1]);
  const month = Number(iso[2]);
  const day = Number(iso[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const calendarDay = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== `${iso[1]}-${iso[2]}-${iso[3]}`) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseTimestamp(value: string, nowMs: number) {
  if (value.toLowerCase() === "now") return nowMs;
  if (/^-?\d{1,16}$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) return undefined;
    const asSeconds = number * 1_000;
    const secondsAreValid = asSeconds >= minTimestampMs && asSeconds <= maxTimestampMs;
    const millisecondsAreValid = number >= minTimestampMs && number <= maxTimestampMs;
    if (secondsAreValid) return asSeconds;
    if (millisecondsAreValid) return number;
    return undefined;
  }
  return parseIsoTimestamp(value);
}

function parseRelativeDuration(value: string, nowMs: number) {
  const sign = value.startsWith("-") ? -1 : 1;
  const duration = value.replace(/^[+-]/, "");
  const parts = [...duration.matchAll(/(\d+(?:\.\d+)?)(mo|y|w|d|h|m|s)/gi)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("").toLowerCase() !== duration.toLowerCase()) return undefined;
  const durationMs = parts.reduce((total, part) => {
    const amount = Number(part[1]);
    const unit = part[2].toLowerCase();
    return total + amount * (relativeDurationUnits[unit] ?? Number.NaN);
  }, 0);
  const timestampMs = Math.round(nowMs + sign * durationMs);
  return Number.isFinite(timestampMs) && timestampMs >= minTimestampMs && timestampMs <= maxTimestampMs
    ? timestampMs
    : undefined;
}

export function parseMessageMacro(source: string, nowMs = Date.now()): ParsedMessageMacro | undefined {
  const match = source.match(/^\{([a-z][a-z0-9_-]*)(?::([^{}\n]*))?\}$/i);
  const requestedName = match?.[1]?.toLowerCase();
  if (!match || !requestedName || !knownMacro(requestedName)) return undefined;
  const name = requestedName;
  const rest = match[2];
  let argument = rest ?? "now";
  let format = defaultFormat(name);
  let hasExplicitFormat = false;
  if (rest !== undefined) {
    const finalSeparator = rest.lastIndexOf(":");
    if (finalSeparator > 0) {
      const candidate = rest.slice(finalSeparator + 1);
      if (validFormat(name, candidate)) {
        argument = rest.slice(0, finalSeparator);
        format = candidate;
        hasExplicitFormat = true;
      }
    }
  }
  if (!argument) return undefined;
  const usesNow = argument.toLowerCase() === "now";
  const referenceMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const timestampMs = parseRelativeDuration(argument, referenceMs) ?? parseTimestamp(argument, referenceMs);
  if (timestampMs === undefined || timestampMs < minTimestampMs || timestampMs > maxTimestampMs) return undefined;
  return { name, timestampMs, format, hasExplicitFormat, usesNow };
}

function dateFormatter(options: Intl.DateTimeFormatOptions) {
  const key = JSON.stringify(options);
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

function formatRelative(timestampMs: number, nowMs: number) {
  const deltaSeconds = (timestampMs - nowMs) / 1_000;
  const absSeconds = Math.abs(deltaSeconds);
  if (absSeconds < 30) return "now";
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 1],
    ["minute", 60],
    ["hour", 3_600],
    ["day", 86_400],
    ["week", 604_800],
    ["month", 2_629_746],
    ["year", 31_556_952],
  ];
  let unit = units[0];
  for (const candidate of units.slice(1)) {
    if (absSeconds < candidate[1] * 1.5) break;
    unit = candidate;
  }
  const amount = Math.round(deltaSeconds / unit[1]);
  return amount === 0 ? "now" : relativeFormatter.format(amount, unit[0]);
}

export function formatMessageMacro(macro: ParsedMessageMacro, nowMs = Date.now()) {
  const date = new Date(macro.timestampMs);
  const format = macro.format;
  if (format === "I" || macro.name === "iso" || macro.name === "dateiso") return date.toISOString();
  if (format === "R") return formatRelative(macro.timestampMs, nowMs);
  if (format === "s" || format === "ms" || macro.name === "unix" || macro.name === "epoch") {
    return format === "ms" ? String(macro.timestampMs) : String(Math.floor(macro.timestampMs / 1_000));
  }
  if (macro.name === "weekday" || macro.name === "dayofweek") return dateFormatter({ weekday: format as "long" | "short" | "narrow" }).format(date);
  if (macro.name === "month") return dateFormatter({ month: format as "long" | "short" | "narrow" }).format(date);
  if (macro.name === "day") return dateFormatter({ day: format === "2" || format === "2-digit" ? "2-digit" : "numeric" }).format(date);
  if (macro.name === "year") return dateFormatter({ year: format === "2" || format === "2-digit" ? "2-digit" : "numeric" }).format(date);
  if (macro.name === "hour") {
    const hourCycle = format === "12" ? "h12" : format === "24" ? "h23" : undefined;
    return dateFormatter({ hour: format === "2" || format === "2-digit" ? "2-digit" : "numeric", ...(hourCycle ? { hourCycle } : {}) }).format(date);
  }
  if (macro.name === "minute" || macro.name === "second") {
    return dateFormatter({ [macro.name]: format === "2" || format === "2-digit" ? "2-digit" : "numeric" }).format(date);
  }
  if (macro.name === "millisecond") return String(date.getMilliseconds()).padStart(3, "0");
  if (macro.name === "dayofyear") {
    const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const yearStart = Date.UTC(date.getFullYear(), 0, 1);
    return formatNumber(Math.floor((day - yearStart) / 86_400_000) + 1, format);
  }
  if (macro.name === "week") {
    const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    utcDate.setUTCDate(utcDate.getUTCDate() + 4 - (utcDate.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
    return formatNumber(Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7), format);
  }
  if (macro.name === "quarter") return formatNumber(Math.floor(date.getMonth() / 3) + 1, format);
  if (macro.name === "timezone" || macro.name === "zone") {
    return dateFormatter({ timeZoneName: format as "short" | "long" }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "";
  }
  if (macro.name === "time12" || macro.name === "time24") {
    return dateFormatter({ hour: "numeric", minute: "2-digit", hourCycle: macro.name === "time12" ? "h12" : "h23" }).format(date);
  }
  let options: Intl.DateTimeFormatOptions;
  switch (format) {
    case "t": options = { hour: "numeric", minute: "2-digit" }; break;
    case "T": options = { hour: "numeric", minute: "2-digit", second: "2-digit" }; break;
    case "d": options = { year: "numeric", month: "numeric", day: "numeric" }; break;
    case "D": options = { year: "numeric", month: "long", day: "numeric" }; break;
    case "F": options = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }; break;
    case "U": options = { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }; break;
    default: options = { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  }
  return dateFormatter(options).format(date);
}

export function messageMacroTooltip(timestampMs: number) {
  const formatter = dateFormatter({ year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "long" });
  return `${formatter.format(new Date(timestampMs))} (${formatter.resolvedOptions().timeZone})`;
}

function formatNumber(value: number, format: string) {
  const width = format === "2" || format === "2-digit" ? 2 : format === "3" ? 3 : 0;
  return String(value).padStart(width, "0");
}

function isEscaped(value: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findClosingBackticks(line: string, start: number, length: number) {
  const marker = "`".repeat(length);
  let candidate = start + length;
  while (candidate < line.length) {
    const index = line.indexOf(marker, candidate);
    if (index < 0) return -1;
    const beforeIsTick = line[index - 1] === "`";
    const afterIsTick = line[index + length] === "`";
    if (!beforeIsTick && !afterIsTick && !isEscaped(line, index)) return index;
    candidate = index + length;
  }
  return -1;
}

function transformOutsideInlineCode(line: string, transform: (plainText: string) => string) {
  let result = "";
  let plainStart = 0;
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`" || isEscaped(line, index)) {
      index += 1;
      continue;
    }
    let length = 1;
    while (line[index + length] === "`") length += 1;
    const close = findClosingBackticks(line, index, length);
    if (close < 0) {
      index += length;
      continue;
    }
    result += transform(line.slice(plainStart, index));
    result += line.slice(index, close + length);
    index = close + length;
    plainStart = index;
  }
  return result + transform(line.slice(plainStart));
}

function transformOutsideCode(value: string, transform: (plainText: string) => string) {
  let inFence = false;
  return value.split("\n").map((line) => {
    if (/^\s*```\s*[\w+-]*\s*$/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return transformOutsideInlineCode(line, (plainText) => {
      let result = "";
      let offset = 0;
      const urls = /https?:\/\/[^\s<>]+/gi;
      for (const match of plainText.matchAll(urls)) {
        const index = match.index ?? offset;
        result += transform(plainText.slice(offset, index));
        result += match[0];
        offset = index + match[0].length;
      }
      return result + transform(plainText.slice(offset));
    });
  }).join("\n");
}

type MacroBudget = { expanded: number };

function replaceMacroTokens(value: string, transform: (macro: ParsedMessageMacro) => string, nowMs: number, budget: MacroBudget) {
  return value.replace(timestampToken, (source, offset: number, whole: string) => {
    if (budget.expanded >= MAX_MESSAGE_MACROS || isEscaped(whole, offset)) return source;
    const macro = parseMessageMacro(source, nowMs);
    if (!macro) return source;
    budget.expanded += 1;
    return transform(macro);
  });
}

export function freezeNowMessageMacros(value: string, sentAtMs = Date.now()) {
  const nowTimestamp = new Date(sentAtMs).toISOString();
  const budget: MacroBudget = { expanded: 0 };
  return transformOutsideCode(value, (plainText) => replaceMacroTokens(plainText, (macro) => {
    const timestamp = macro.usesNow ? nowTimestamp : new Date(macro.timestampMs).toISOString();
    return `{${macro.name}:${timestamp}${macro.hasExplicitFormat ? `:${macro.format}` : ""}}`;
  }, sentAtMs, budget));
}

export function formatMessageMacrosAsText(value: string, referenceMs = Date.now()) {
  const budget: MacroBudget = { expanded: 0 };
  return transformOutsideCode(value, (plainText) => replaceMacroTokens(plainText, (macro) => formatMessageMacro(macro, referenceMs), referenceMs, budget));
}

export function refreshRelativeTimeMacros(root: ParentNode = document, nowMs = Date.now()) {
  for (const element of root.querySelectorAll<HTMLTimeElement>('time[data-message-macro="true"][data-macro-format="R"]')) {
    const timestampMs = Number(element.dataset.timestampMs);
    if (!Number.isFinite(timestampMs)) continue;
    const macro: ParsedMessageMacro = {
      name: "relative",
      timestampMs,
      format: "R",
      hasExplicitFormat: false,
      usesNow: false,
    };
    element.textContent = formatMessageMacro(macro, nowMs);
    element.title = messageMacroTooltip(timestampMs);
    element.setAttribute("aria-label", `${element.textContent} · ${element.title}`);
  }
}
