import {
  AuthIdentitySchema,
  AuthSessionSchema,
  LoginRequestSchema,
} from "@ragsystem/api-contracts";
import { describe, expect, it } from "vitest";

describe("共享认证 REST 契约", () => {
  it("校验登录请求和会话响应", () => {
    expect(LoginRequestSchema.parse({ username: " admin ", password: "secret" }).username).toBe("admin");
    expect(() => AuthSessionSchema.parse({ token: "token" })).toThrow();
  });

  it("拒绝身份响应中的未知角色", () => {
    expect(() => AuthIdentitySchema.parse({
      user: { id: "usr_admin", displayName: "Admin" },
      userId: "usr_admin",
      tenantId: "tnt_default",
      role: "super-admin",
      permissions: ["*"],
      platformRole: "admin",
    })).toThrow();
  });
});
