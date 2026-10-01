import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const frontend = resolve(root, "shared-frontend");
if (!await Bun.file(resolve(frontend, "package.json")).exists()) {
  throw new Error("Initialize the frontend with git submodule update --init --recursive, then npm --prefix shared-frontend ci.");
}
const build = Bun.spawn([process.platform === "win32" ? "npm.cmd" : "npm", "run", "build:web"], {
  cwd: frontend, stdout: "inherit", stderr: "inherit",
});
if (await build.exited !== 0) process.exit(1);
await mkdir(resolve(root, "public"), { recursive: true });
await cp(resolve(frontend, ".build/web"), resolve(root, "public"), { recursive: true });

// The instance-admin console remains owned and built by the server repository.
const adminEntries = ["instance-admin", "instance-users", "instance-spaces", "instance-operations", "instance-maintenance", "instance-operators", "instance-admin-login"];
for (const entry of adminEntries) {
  const result = await Bun.build({
    entrypoints: [`client/${entry}.ts`],
    outdir: "public",
    target: "browser",
    naming: {
      entry: `${entry}.js`,
      chunk: "[name]-[hash].js",
      asset: "assets/[name].[ext]",
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

for (const page of adminEntries) {
  const html = await Bun.file(`client/${page}.html`).text();
  await Bun.write(`public/${page}.html`, html.replaceAll('href="/app.css"', 'href="/instance-admin.css"'));
}
await Bun.write("public/instance-admin-theme-init.js", Bun.file("client/instance-admin-theme-init.js"));
const styleSheets = [
  "base.css",
  "navigation.css",
  "conversation.css",
  "composer.css",
  "profile-editor.css",
  "pages.css",
  "responsive.css",
  "controls.css",
  "space-settings.css",
];
const bundledStyles = (await Promise.all(styleSheets.map((sheet) => Bun.file(`client/styles/${sheet}`).text()))).join("");
await Bun.write("public/instance-admin.css", bundledStyles);

console.log("Built shared browser frontend and server-owned admin console in public/");
