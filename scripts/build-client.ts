import { emojiAssetCodes } from "../client/emoji-data";

for (const entry of ["auth", "register", "unlock", "main", "new", "settings", "server-settings", "instance-admin", "instance-admin-login"]) {
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

for (const page of ["index", "register", "unlock", "chat", "new", "settings", "server-settings", "instance-admin", "instance-admin-login"]) {
  await Bun.write(`public/${page}.html`, Bun.file(`client/${page}.html`));
}
const styleSheets = [
  "base.css",
  "navigation.css",
  "conversation.css",
  "composer.css",
  "profile-editor.css",
  "pages.css",
  "responsive.css",
];
const bundledStyles = (await Promise.all(styleSheets.map((sheet) => Bun.file(`client/styles/${sheet}`).text()))).join("");
await Bun.write("public/app.css", bundledStyles);
await Bun.write("public/favicon.svg", Bun.file("client/favicon.svg"));
await Bun.write("public/push-sw.js", Bun.file("client/push-sw.js"));
await Bun.write(
  "public/assets/matrix_sdk_crypto_wasm_bg.wasm",
  Bun.file("node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm"),
);
for (const code of emojiAssetCodes) {
  await Bun.write(`public/assets/twemoji/${code}.svg`, Bun.file(`client/assets/twemoji/${code}.svg`));
}
await Bun.write("public/assets/twemoji/NOTICE.txt", Bun.file("client/assets/twemoji/NOTICE.txt"));

console.log("Built browser client in public/");
