import assert from "node:assert/strict";
import test from "node:test";

import { createLocalProductPlugins } from "../dist/product-plugins.js";

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

test("Local product dynamically loads every installed plugin by default", async () => {
  assert.deepEqual(pluginIds(await createLocalProductPlugins()), ALL_IDS);
});

test("Local product imports nothing when plugins are disabled", async () => {
  let imports = 0;
  const plugins = await createLocalProductPlugins("none", {
    importModule: async () => {
      imports += 1;
      throw new Error("must not import");
    },
  });
  assert.deepEqual(plugins, []);
  assert.equal(imports, 0);
});

test("Local product supports dynamic subset ordering", async () => {
  assert.deepEqual(pluginIds(await createLocalProductPlugins("skills,artifacts")), [
    "@ragsystem/backend-plugin-skills",
    "@ragsystem/backend-plugin-artifacts",
  ]);
  await assert.rejects(createLocalProductPlugins("missing"), /Backend plugins are not installed: missing/);
});

function pluginIds(plugins) {
  return plugins.map((plugin) => plugin.manifest.id);
}
