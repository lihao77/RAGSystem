import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const botConsumers = [
  "src/routes/bots.ts",
  "src/routes/platform.ts",
  "src/routes/session-owner.ts",
  "src/routes/agent/sessions.ts",
  "src/services/daemon/daemon-service.ts",
];

describe("BotRepository architecture", () => {
  it("keeps Bot consumers behind the async repository port", () => {
    const violations = botConsumers.flatMap((file) => {
      const content = fs.readFileSync(path.resolve(file), "utf8");
      const issues: string[] = [];
      if (/control-store|\bControlStore\b|\.controlStore\b/.test(content)) {
        issues.push(`${file}: references the SQLite ControlStore`);
      }
      if (/\.db\.(?:exec|prepare)\(/.test(content)) {
        issues.push(`${file}: accesses SQLite directly`);
      }
      return issues;
    });
    expect(violations).toEqual([]);
  });
});
