export {};

const result = await Bun.build({
  entrypoints: ["client/main.ts"],
  outdir: "public",
  target: "browser",
  naming: {
    entry: "app.js",
    chunk: "[name]-[hash].js",
    asset: "assets/[name].[ext]",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await Bun.write("public/index.html", Bun.file("client/index.html"));
await Bun.write("public/app.css", Bun.file("client/styles.css"));
await Bun.write(
  "public/assets/matrix_sdk_crypto_wasm_bg.wasm",
  Bun.file("node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm"),
);

console.log("Built browser client in public/");
