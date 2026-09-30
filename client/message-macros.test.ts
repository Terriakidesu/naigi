import { expect, test } from "bun:test";
import {
  formatMessageMacro,
  messageMacroTooltip,
  refreshRelativeTimeMacros,
  formatMessageMacrosAsText,
  freezeNowMessageMacros,
  parseMessageMacro,
} from "./message-macros";

const now = Date.parse("2025-03-04T05:06:07.890Z");

test("macro tooltips include the absolute date, seconds, and viewer timezone", () => {
  const tooltip = messageMacroTooltip(now);
  expect(tooltip).toContain("2025");
  expect(tooltip).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(tooltip).toContain("07");
  const relative = parseMessageMacro("{relative:2d}", now)!;
  expect(messageMacroTooltip(relative.timestampMs)).not.toBe(tooltip);
});

test("relative macro refresh retains timezone tooltip and accessible date", () => {
  const attributes = new Map<string, string>();
  const element = { dataset: { timestampMs: String(now + 172_800_000) }, textContent: "", title: "", setAttribute: (name: string, value: string) => attributes.set(name, value) };
  const root = { querySelectorAll: () => [element] } as unknown as ParentNode;
  refreshRelativeTimeMacros(root, now);
  expect(element.textContent).toBe("in 2 days");
  expect(element.title).toBe(messageMacroTooltip(now + 172_800_000));
  expect(attributes.get("aria-label")).toContain(element.title);
  refreshRelativeTimeMacros(root, now + 86_400_000);
  expect(element.textContent).toBe("in 24 hours");
  expect(element.title).toBe(messageMacroTooltip(now + 172_800_000));
});

test("message macros accept no argument, now, Unix seconds, milliseconds, and ISO dates", () => {
  expect(parseMessageMacro("{time}", now)).toMatchObject({ name: "time", timestampMs: now, format: "t", usesNow: true });
  expect(parseMessageMacro("{date:now}", now)).toMatchObject({ name: "date", timestampMs: now, format: "d" });
  expect(parseMessageMacro("{timestamp:1741064767}", now)?.timestampMs).toBe(1_741_064_767_000);
  expect(parseMessageMacro("{timestamp:1741064767890}", now)?.timestampMs).toBe(1_741_064_767_890);
  expect(parseMessageMacro("{timestamp:946684800000}", now)?.timestampMs).toBe(946_684_800_000);
  expect(parseMessageMacro("{timestamp:253402300799}", now)?.timestampMs).toBe(253_402_300_799_000);
  expect(parseMessageMacro("{timestamp:2025-03-04T05:06:07.890Z}", now)?.timestampMs).toBe(now);
  expect(parseMessageMacro("{timestamp:2025-02-30}", now)).toBeUndefined();
  expect(parseMessageMacro("{unknown:now}", now)).toBeUndefined();
  expect(parseMessageMacro("{date:now:not-a-flag}", now)).toBeUndefined();
});

test("timestamp format flags and additional date/time macros render", () => {
  const timestamp = parseMessageMacro("{timestamp:now:I}", now);
  expect(timestamp).toMatchObject({ format: "I", hasExplicitFormat: true });
  expect(formatMessageMacro(timestamp!, now)).toBe("2025-03-04T05:06:07.890Z");
  expect(formatMessageMacro(parseMessageMacro("{timestamp:now:s}", now)!, now)).toBe("1741064767");
  expect(formatMessageMacro(parseMessageMacro("{timestamp:now:ms}", now)!, now)).toBe("1741064767890");
  expect(formatMessageMacro(parseMessageMacro("{millisecond:now}", now)!, now)).toBe("890");
  expect(formatMessageMacro(parseMessageMacro("{quarter:now}", now)!, now)).toBe("1");
  expect(formatMessageMacro(parseMessageMacro("{week:2021-01-01}", now)!, now)).toBe("53");
  expect(formatMessageMacro(parseMessageMacro("{time24:now}", now)!, now)).not.toBe("");
  expect(formatMessageMacro(parseMessageMacro("{hour:now:24}", now)!, now)).not.toBe("");
  expect(formatMessageMacro(parseMessageMacro("{timezone:now}", now)!, now)).not.toBe("");
});

test("relative macros accept signed and compound duration offsets", () => {
  const twoHours = parseMessageMacro("{relative:2h}", now);
  expect(twoHours?.timestampMs).toBe(now + 2 * 60 * 60 * 1_000);
  expect(formatMessageMacro(twoHours!, now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(2, "hour"));
  expect(parseMessageMacro("{relative:-30m}", now)?.timestampMs).toBe(now - 30 * 60 * 1_000);
  expect(parseMessageMacro("{relative:1d2h}", now)?.timestampMs).toBe(now + 26 * 60 * 60 * 1_000);
  expect(parseMessageMacro("{relative:1mo}", now)?.timestampMs).toBe(now + 2_629_746_000);
  expect(parseMessageMacro("{relative:2days}", now)).toBeUndefined();
  expect(freezeNowMessageMacros("{relative:2h}", now)).toBe("{relative:2025-03-04T07:06:07.890Z}");
});

test("all date and time macros accept duration offsets", () => {
  const twoHoursLater = now + 2 * 60 * 60 * 1_000;
  for (const source of ["{time:2h}", "{date:2h}", "{timestamp:2h:f}", "{datetime:2h}", "{relative:2h}", "{iso:2h}", "{unix:2h}", "{weekday:2h}", "{hour:2h}"]) {
    expect(parseMessageMacro(source, now)?.timestampMs).toBe(twoHoursLater);
  }
  expect(parseMessageMacro("{date:-1d}", now)?.timestampMs).toBe(now - 86_400_000);
  expect(freezeNowMessageMacros("{time:2h}", now)).toBe("{time:2025-03-04T07:06:07.890Z}");
});

test("send-time expansion freezes only valid macros outside code, URLs, and escaped braces", () => {
  const source = [
    "At {time:now} on {date}, stamp {timestamp:now:R}.",
    "Inline `{date:now}` and URL https://example.test/{time:now} stay literal.",
    String.raw`Escaped \{date:now} stays literal.`,
    "```txt",
    "{time:now}",
    "```",
  ].join("\n");
  const frozen = freezeNowMessageMacros(source, now);
  expect(frozen).toBe([
    "At {time:2025-03-04T05:06:07.890Z} on {date:2025-03-04T05:06:07.890Z}, stamp {timestamp:2025-03-04T05:06:07.890Z:R}.",
    "Inline `{date:now}` and URL https://example.test/{time:now} stay literal.",
    String.raw`Escaped \{date:now} stays literal.`,
    "```txt",
    "{time:now}",
    "```",
  ].join("\n"));
});

test("macro processing has a per-message expansion budget", () => {
  const source = Array.from({ length: 101 }, () => "{time:now}").join(" ");
  const frozen = freezeNowMessageMacros(source, now);
  expect(frozen.match(/\{time:2025-/g)).toHaveLength(100);
  expect(frozen.endsWith("{time:now}")).toBe(true);
});

test("macro text rendering shows formatted values and leaves code and malformed macros alone", () => {
  expect(formatMessageMacrosAsText("{timestamp:now:I} {unix:now} `{time:now}` {unknown:now}", now))
    .toBe("2025-03-04T05:06:07.890Z 1741064767 `{time:now}` {unknown:now}");
});
