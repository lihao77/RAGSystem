import assert from "node:assert/strict";
import test from "node:test";

import { createSaaSProductPlugins } from "../dist/product-plugins.js";

const ALL_IDS = [
  "@ragsystem/backend-plugin-artifacts",
  "@ragsystem/backend-plugin-knowledge",
  "@ragsystem/backend-plugin-memory",
  "@ragsystem/backend-plugin-mcp",
  "@ragsystem/backend-plugin-skills",
];

test("SaaS product plugin catalog defaults to every bundled plugin", () => {
  assert.deepEqual(pluginIds(createSaaSProductPlugins(deployment())), ALL_IDS);
});

test("SaaS product plugin catalog supports disabling and subset ordering", () => {
  assert.deepEqual(createSaaSProductPlugins(deployment(), "none"), []);
  assert.deepEqual(pluginIds(createSaaSProductPlugins(deployment(), "knowledge,memory")), [
    "@ragsystem/backend-plugin-knowledge",
    "@ragsystem/backend-plugin-memory",
  ]);
  assert.throws(
    () => createSaaSProductPlugins(deployment(), "missing"),
    /Backend plugins are not installed: missing/,
  );
});

function pluginIds(plugins) {
  return plugins.map((plugin) => plugin.manifest.id);
}

function deployment() {
  return {
    applications: {},
    pluginResources: {
      database: {},
      objects: {},
      secrets: {},
    },
  };
}
