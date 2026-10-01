import { expect, test } from "bun:test";
import { deviceClientName } from "./device-client";

test("client types map to fixed human-readable device names", () => {
  expect(deviceClientName("desktop")).toBe("Naigi Desktop");
  expect(deviceClientName("web")).toBe("Web browser");
});

test("legacy uploads do not overwrite an identified device", () => {
  expect(deviceClientName(undefined)).toBeUndefined();
});

test("invalid client metadata is rejected instead of stored", () => {
  for (const input of [null, "", "mobile", "Desktop", 1, {}, ["web"], "x".repeat(1000)]) {
    expect(deviceClientName(input)).toBeNull();
  }
});
