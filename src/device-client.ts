export function deviceClientName(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (value === "desktop") return "Naigi Desktop";
  if (value === "web") return "Web browser";
  return null;
}
