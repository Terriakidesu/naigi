/**
 * Serves files from the built `public/` directory.
 *
 * `import.meta.dir` is this module's directory, so the path to the build output is two levels up
 * rather than one. Every name is validated against a conservative character set before it is
 * joined, which is what keeps `..` and absolute paths out of the filesystem lookup.
 */

const publicRoot = `${import.meta.dir}/../../public`;

/**
 * Resolves a path inside the built `public/` directory.
 *
 * Route modules live at different depths, so they must not build this path themselves with
 * `import.meta.dir`; doing so silently resolves against the wrong directory once a route moves into
 * a subdirectory. Callers validate the name first, and the traversal check here is the backstop.
 */
export function publicAssetFile(relativePath: string) {
  if (
    relativePath.includes("..")
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.includes("\0")
  ) {
    return null;
  }
  return Bun.file(`${publicRoot}/${relativePath}`);
}

export async function publicFile(name: string, contentType: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const file = Bun.file(`${publicRoot}/${name}`);
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "cache-control": "no-cache", "content-type": contentType } });
}
