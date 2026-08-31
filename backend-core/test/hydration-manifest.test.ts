import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AGENT_CONFIG_MIGRATION_STEPS } from "../src/services/agent/config/agent-config-hydration.js";
import { PROVIDER_FORM_NORMALIZATION_STEPS } from "../src/services/integrations/model-adapter-hydration.js";

const MANIFEST_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../MIGRATIONS.md");

/**
 * 清单自证：代码中注册的每个水合/迁移步骤 id 必须出现在 backend-core/MIGRATIONS.md。
 * 把"新增步骤必须登记"从口头约定变成可执行检查；漏登记会在 CI 直接失败。
 */
describe("hydration manifest", () => {
  const manifest = readFileSync(MANIFEST_PATH, "utf8");
  const stepIds = [
    ...AGENT_CONFIG_MIGRATION_STEPS.map((step) => step.id),
    ...PROVIDER_FORM_NORMALIZATION_STEPS.map((step) => step.id),
  ];

  it("every registered step id is documented in MIGRATIONS.md", () => {
    expect(stepIds.length).toBeGreaterThan(0);
    const missing = stepIds.filter((id) => !manifest.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  it("step ids are unique across stores", () => {
    expect(new Set(stepIds).size).toBe(stepIds.length);
  });
});
