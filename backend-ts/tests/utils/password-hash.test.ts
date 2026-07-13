import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/utils/password-hash.js";

describe("password-hash", () => {
  it("使用 scrypt 哈希并校验密码", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt:16384:1:8:[0-9a-f]+:[0-9a-f]+$/);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong", stored)).toBe(false);
    expect(verifyPassword("wrong", "invalid")).toBe(false);
  });
});
