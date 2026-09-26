export {};

for (const entry of ["auth", "register", "unlock", "main", "new", "settings"]) {
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

for (const page of ["index", "register", "unlock", "chat", "new", "settings"]) {
  await Bun.write(`public/${page}.html`, Bun.file(`client/${page}.html`));
}
await Bun.write("public/app.css", Bun.file("client/styles.css"));
await Bun.write(
  "public/assets/matrix_sdk_crypto_wasm_bg.wasm",
  Bun.file("node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm"),
);

console.log("Built browser client in public/");
