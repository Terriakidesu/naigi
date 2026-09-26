import { afterEach, beforeEach, expect, test } from "bun:test";
import { confirmLocalUnlock, localSessionLocked, lockLocalSession, rememberedUnlockSupported, resolveLocalPassphrase, setSessionPassphrase } from "./unlock-vault";

const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  });
});

afterEach(() => {
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});

test("navigation handoff consumes the passphrase only once", async () => {
  setSessionPassphrase("local-test-passphrase");

  expect(await resolveLocalPassphrase("user-a")).toBe("local-test-passphrase");
  expect(await resolveLocalPassphrase("user-a")).toBeNull();
});

test("without a secure remembered vault there is no persistent passphrase fallback", async () => {
  expect(rememberedUnlockSupported()).toBe(false);
  expect(await resolveLocalPassphrase("user-a")).toBeNull();
});

test("manual lock blocks automatic unlock until a passphrase is entered", async () => {
  setSessionPassphrase("local-test-passphrase");
  lockLocalSession();

  expect(localSessionLocked()).toBe(true);
  expect(await resolveLocalPassphrase("user-a")).toBeNull();
  setSessionPassphrase("local-test-passphrase");
  expect(localSessionLocked()).toBe(true);
  expect(await resolveLocalPassphrase("user-a")).toBe("local-test-passphrase");
  expect(await resolveLocalPassphrase("user-a")).toBeNull();
  confirmLocalUnlock();
  expect(localSessionLocked()).toBe(false);
});
