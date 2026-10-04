/**
 * Serves files from the built `public/` directory.
 *
 * `import.meta.dir` is this module's directory, so the path to the build output is two levels up
 * rather than one. Every name is validated against a conservative character set before it is
 * joined, which is what keeps `..` and absolute paths out of the filesystem lookup.
 */

const publicRoot = `${import.meta.dir}/../../public`;

export async function publicFile(name: string, contentType: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const file = Bun.file(`${publicRoot}/${name}`);
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "no-cache", "content-type": contentType } });
}

export async function publicFileAt(relativePath: string, contentType: string, cacheControl: string) {
  // Chunk and asset names are validated by their callers, which constrain them to a segment with
  // no separators; this check is the backstop that keeps a crafted name inside the directory.
  if (relativePath.includes("..") || relativePath.startsWith("/") || relativePath.includes("\\")) return null;
  const file = Bun.file(`${publicRoot}/${relativePath}`);
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": cacheControl, "content-type": contentType } });
}
