export function roomReferenceSlug(name: string, fallback = "room") {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
  return slug || fallback;
}

export function roomReferenceToken(value: string, cursor = value.length) {
  const before = value.slice(0, cursor);
  const match = before.match(/(^|\s)#([A-Za-z0-9_.-]*)$/);
  if (!match) return null;
  return {
    query: match[2].toLowerCase(),
    start: before.length - match[0].length + match[1].length,
    end: cursor,
  };
}
