import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const consumers = [
  "src/routes/widget.ts",
  "src/routes/widget-apps.ts",
  "src/routes/agent/agui.ts",
  "src/services/identity/widget-identity-provider.ts",
  "src/services/runtime/jwt-service.ts",
];

describe("Widget credential architecture", () => {
  it("keeps routes, identity and JWT services behind the async repository port", () => {
    const violations = consumers.flatMap((file) => {
      const content = fs.readFileSync(path.resolve(file), "utf8");
      const issues: string[] = [];
      if (/stores\/widget-credential-store/.test(content)) issues.push(`${file}: imports the SQLite widget store`);
      if (/\.ops\./.test(content)) issues.push(`${file}: accesses legacy synchronous widget ops`);
      return issues;
    });
    expect(violations).toEqual([]);
  });
});
