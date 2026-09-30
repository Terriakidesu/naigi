import { expect, test } from "bun:test";
import { createApp } from "./app";
import { serverVersionInfo } from "./server-version";

test("public server version metadata is named and reports API v1", () => {
  expect(serverVersionInfo()).toMatchObject({
    name: "Naigi",
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    apiVersion: 1,
  });
});

test("GET /v1/version is public and returns server metadata", async () => {
  const response = await createApp().handle(new Request("http://localhost/v1/version"));

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(serverVersionInfo());
});
