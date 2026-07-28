import assert from "node:assert/strict";
import path from "node:path";
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
];

test("Local product plugin catalog defaults to every bundled plugin", () => {
  assert.deepEqual(pluginIds(createLocalProductPlugins(deployment(), env())), ALL_IDS);
});

test("Local product plugin catalog supports disabling and subset ordering", () => {
  assert.deepEqual(createLocalProductPlugins(deployment(), env(), "none"), []);
  assert.deepEqual(pluginIds(createLocalProductPlugins(deployment(), env(), "skills,artifacts")), [
    "@ragsystem/backend-plugin-skills",
    "@ragsystem/backend-plugin-artifacts",
  ]);
  assert.throws(
    () => createLocalProductPlugins(deployment(), env(), "missing"),
    /Backend plugins are not installed: missing/,
  );
});

function pluginIds(plugins) {
  return plugins.map((plugin) => plugin.manifest.id);
}

function deployment() {
  return { applications: {} };
}

function env() {
  return { tenantsRoot: path.resolve(".ragsystem-test", "tenants") };
}
