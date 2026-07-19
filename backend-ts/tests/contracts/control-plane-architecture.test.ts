import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const coreFiles = [
  "src/routes/auth.ts",
  "src/routes/admin.ts",
  "src/routes/platform.ts",
  "src/routes/platform-guard.ts",
  "src/routes/bootstrap.ts",
  "src/routes/health.ts",
  "src/services/identity/local-identity-provider.ts",
  "src/services/identity/password-identity-provider.ts",
  "src/services/runtime/session-token-service.ts",
  "src/adapters/local/tenant-runtime-registry.ts",
  "src/app/route-assembly.ts",
];

describe("control plane architecture", () => {
  it("keeps core consumers behind async control-plane ports", () => {
    const violations = coreFiles.flatMap((file) => {
      const content = fs.readFileSync(path.resolve(file), "utf8");
      const issues: string[] = [];
      if (/control-store|\bControlStore\b/.test(content)) issues.push(`${file}: references the SQLite ControlStore`);
      if (/\.db\.(?:exec|prepare)\(/.test(content)) issues.push(`${file}: accesses the control database directly`);
      if (/node:sqlite/.test(content)) issues.push(`${file}: imports node:sqlite`);
      return issues;
    });

    expect(violations).toEqual([]);
  });

  it("selects platform identity through route composition instead of URL inspection", () => {
    const provider = fs.readFileSync(path.resolve("src/services/identity/password-identity-provider.ts"), "utf8");
    expect(provider).not.toMatch(/request\.url|startsWith\("\/api\/platform/);
    expect(provider).toContain('scope === "platform"');
  });
});
