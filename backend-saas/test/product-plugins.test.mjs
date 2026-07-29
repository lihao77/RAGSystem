import assert from "node:assert/strict";
import test from "node:test";

import { createSaaSProductPlugins } from "../dist/product-plugins.js";

const ALL_IDS = [
  "@ragsystem/backend-plugin-artifacts",
  "@ragsystem/backend-plugin-execution-tools",
  "@ragsystem/backend-plugin-document-tools",
  "@ragsystem/backend-plugin-daemon-feishu",
  "@ragsystem/backend-plugin-knowledge",
  "@ragsystem/backend-plugin-memory",
  "@ragsystem/backend-plugin-mcp",
  "@ragsystem/backend-plugin-skills",
  "@ragsystem/backend-plugin-widget",
];

test("SaaS product dynamically loads every installed plugin by default", async () => {
  assert.deepEqual(pluginIds(await createSaaSProductPlugins()), ALL_IDS);
});

test("SaaS product imports nothing when plugins are disabled", async () => {
  let imports = 0;
  const plugins = await createSaaSProductPlugins("none", {
    importModule: async () => {
      imports += 1;
      throw new Error("must not import");
    },
  });
  assert.deepEqual(plugins, []);
  assert.equal(imports, 0);
});

test("SaaS product supports dynamic subset ordering", async () => {
  assert.deepEqual(pluginIds(await createSaaSProductPlugins("knowledge,memory")), [
    "@ragsystem/backend-plugin-knowledge",
    "@ragsystem/backend-plugin-memory",
  ]);
  await assert.rejects(createSaaSProductPlugins("missing"), /Backend plugins are not installed: missing/);
});

function pluginIds(plugins) {
  return plugins.map((plugin) => plugin.manifest.id);
}
