import { expect, test } from "bun:test";
import { createApp } from "./app";
import { serverVersionInfo } from "./server-version";

test("public server version metadata is named and reports API v1", () => {
  expect(serverVersionInfo()).toMatchObject({
    name: "Naigi",
    // SemVer with an optional pre-release suffix, so in-progress work can carry a `-dev` marker
    // that distinguishes it from a released version.
    version: expect.stringMatching(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    apiVersion: 1,
  });
});

test("GET /v1/version is public and returns server metadata", async () => {
  const response = await createApp().handle(new Request("http://localhost/v1/version"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(serverVersionInfo());
});
