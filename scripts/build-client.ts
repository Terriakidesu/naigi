export {};

for (const entry of ["auth", "register", "unlock", "main", "new", "settings", "server-settings"]) {
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

for (const page of ["index", "register", "unlock", "chat", "new", "settings", "server-settings"]) {
  await Bun.write(`public/${page}.html`, Bun.file(`client/${page}.html`));
}
await Bun.write("public/app.css", Bun.file("client/styles.css"));
await Bun.write("public/favicon.svg", Bun.file("client/favicon.svg"));
await Bun.write(
  "public/assets/matrix_sdk_crypto_wasm_bg.wasm",
  Bun.file("node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm"),
);
for (const emoji of ["1f44d", "2764", "1f602", "1f62e", "1f622", "1f621", "1f389", "1f680", "1f440", "2705"]) {
  await Bun.write(`public/assets/twemoji/${emoji}.svg`, Bun.file(`client/assets/twemoji/${emoji}.svg`));
}
await Bun.write("public/assets/twemoji/NOTICE.txt", Bun.file("client/assets/twemoji/NOTICE.txt"));

console.log("Built browser client in public/");
