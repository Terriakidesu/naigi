import { describe, expect, test } from "bun:test";
import { attachmentPath, profileImagePath } from "./storage";

describe("attachment storage keys", () => {
  test("preserves the validated extension without allowing path traversal", () => {
    const path = attachmentPath("123e4567-e89b-12d3-a456-426614174000.webp");

    expect(path).toEndWith("/123e4567-e89b-12d3-a456-426614174000.webp");
    expect(() => attachmentPath("../../private.txt")).toThrow();
  });

  test("keeps profile image storage keys constrained to the profile image directory", () => {
    const path = profileImagePath("123e4567-e89b-12d3-a456-426614174000.gif");

    expect(path).toEndWith("/123e4567-e89b-12d3-a456-426614174000.gif");
    expect(() => profileImagePath("../../private.txt")).toThrow();
  });
});
