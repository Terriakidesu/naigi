import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

export function serverVersionInfo() {
  return {
    name: "Naigi",
    version: packageMetadata.version,
    apiVersion: 1,
  };
}
