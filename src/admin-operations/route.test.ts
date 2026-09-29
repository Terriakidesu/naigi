import { expect, test } from "bun:test";
import { createApp } from "../app";

test("instance operations snapshot is restricted to host operators", async () => {
  const response = await createApp().handle(new Request("http://localhost/v1/instance-admin/operations"));

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("live resource samples are restricted to host operators", async () => {
  const response = await createApp().handle(new Request("http://localhost/v1/instance-admin/operations/live"));

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("instance overview metrics are restricted to host operators", async () => {
  const response = await createApp().handle(new Request("http://localhost/v1/instance-admin/operations/overview"));

  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthorized" });
});

test("instance user directory and warning management are restricted to host operators", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const warningId = "22222222-2222-4222-8222-222222222222";
  const paths: Array<[string, string, unknown?]> = [
    ["GET", "/v1/instance-admin/users?search=naigi"],
    ["GET", `/v1/instance-admin/users/${userId}`],
    ["POST", `/v1/instance-admin/users/${userId}/warnings`, { reason: "test warning" }],
    ["DELETE", `/v1/instance-admin/warnings/${warningId}`],
  ];
  for (const [method, path, body] of paths) {
    const response = await createApp().handle(new Request(`http://localhost${path}`, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  }
});

test("chat warning delivery and acknowledgement endpoints require the affected user's session", async () => {
  const warningId = "22222222-2222-4222-8222-222222222222";
  const paths = [
    ["GET", "/v1/me/instance-warnings"],
    ["PATCH", `/v1/me/instance-warnings/${warningId}/acknowledge`],
    ["GET", "/v1/me/server-warnings"],
    ["PATCH", `/v1/me/server-warnings/${warningId}/acknowledge`],
  ] as const;
  for (const [method, path] of paths) {
    const response = await createApp().handle(new Request(`http://localhost${path}`, { method }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  }
});

test("storage maintenance operations are restricted to host operators", async () => {
  const paths = [
    ["GET", "/v1/instance-admin/maintenance/summary"],
    ["POST", "/v1/instance-admin/maintenance/preview"],
    ["POST", "/v1/instance-admin/maintenance/quarantine"],
    ["POST", "/v1/instance-admin/maintenance/restore"],
    ["POST", "/v1/instance-admin/maintenance/purge"],
  ] as const;

  for (const [method, path] of paths) {
    const response = await createApp().handle(new Request(`http://localhost${path}`, { method }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  }
});
