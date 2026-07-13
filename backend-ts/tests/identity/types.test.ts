import { describe, expect, it } from "vitest";
import { createTenantId, createUserId, isTenantId, isUserId } from "../../src/identity/types.js";

describe("identity branded types", () => {
  it("接受规范化租户和用户 ID", () => {
    expect(createTenantId(" tnt_local ")).toBe("tnt_local");
    expect(createUserId("usr_local")).toBe("usr_local");
    expect(isTenantId("tnt_acme_cn")).toBe(true);
    expect(isUserId("usr_alice_01")).toBe(true);
  });

  it("拒绝不符合前缀和字符规范的 ID", () => {
    expect(() => createTenantId("tenant-local")).toThrow("无效租户 ID");
    expect(() => createUserId("usr/Alice")).toThrow("无效用户 ID");
  });
});
