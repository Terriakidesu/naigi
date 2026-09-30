export type ComposerFormat = "bold" | "italic" | "strike" | "spoiler";
export const formatMarkers: Record<ComposerFormat, string> = { bold: "**", italic: "_", strike: "~~", spoiler: "||" };

export function formatComposerSelection(value: string, start: number, end: number, format: ComposerFormat) {
  const marker = formatMarkers[format];
  const selected = value.slice(start, end);
  let from = start;
  let to = end;
  let replacement: string;
  let selectionStart: number;
  let selectionEnd: number;
  if (start >= marker.length && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker) {
    from -= marker.length;
    to += marker.length;
    replacement = selected;
    selectionStart = from;
    selectionEnd = from + replacement.length;
  } else if (!selected.includes("\n") && selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
    replacement = selected.slice(marker.length, -marker.length);
    selectionStart = from;
    selectionEnd = from + replacement.length;
  } else if (selected.includes("\n")) {
    const lines = selected.split("\n");
    const unwrap = lines.filter((line) => line.trim()).every((line) => line.trim().startsWith(marker) && line.trim().endsWith(marker) && line.trim().length >= marker.length * 2);
    replacement = lines.map((line) => line.replace(/^(\s*)(\S(?:.*\S)?)(\s*)$/, (_, before, content, after) =>
      `${before}${unwrap ? content.slice(marker.length, -marker.length) : `${marker}${content}${marker}`}${after}`)).join("\n");
    selectionStart = from;
    selectionEnd = from + replacement.length;
  } else {
    const leading = selected.match(/^\s*/)?.[0] ?? "";
    const content = selected.slice(leading.length).trimEnd();
    const trailing = selected.slice(leading.length + content.length);
    replacement = `${leading}${marker}${content}${marker}${trailing}`;
    selectionStart = from + leading.length + marker.length;
    selectionEnd = selectionStart + content.length;
  }
  return { from, to, replacement, selectionStart, selectionEnd, value: value.slice(0, from) + replacement + value.slice(to) };
}

export function composerFormatShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">): ComposerFormat | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
  const key = event.key.toLowerCase();
  if (!event.shiftKey && key === "b") return "bold";
  if (!event.shiftKey && key === "i") return "italic";
  if (event.shiftKey && key === "x") return "strike";
  if (event.shiftKey && key === "s") return "spoiler";
}
