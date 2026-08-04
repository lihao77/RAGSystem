import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createSaaSProductPlugins } from "../dist/product-plugins.js";

const ALL_IDS = [
  "@ragsystem/backend-plugin-artifacts",
  "@ragsystem/backend-plugin-sandbox",
  "@ragsystem/backend-plugin-execution-tools",
  "@ragsystem/backend-plugin-document-tools",
  "@ragsystem/backend-plugin-daemon-feishu",
  "@ragsystem/backend-plugin-knowledge",
  "@ragsystem/backend-plugin-memory",
  "@ragsystem/backend-plugin-mcp",
  "@ragsystem/backend-plugin-skills",
  "@ragsystem/backend-plugin-agent-builder",
  "@ragsystem/backend-plugin-widget",
];

test("SaaS product loads the configured plugins by default", async () => {
  assert.deepEqual(pluginIds(await createSaaSProductPlugins()), ALL_IDS);
});

test("SaaS product imports nothing when plugins are disabled", async () => {
  const directory = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "ragsystem-saas-disabled-"));
  const configPath = path.join(directory, "plugins.yaml");
  fs.writeFileSync(configPath, "version: 1\nplugins:\n  - module: disabled\n    enabled: false\n", "utf8");
  let imports = 0;
  try {
    const plugins = await createSaaSProductPlugins({
      configPath,
      importModule: async () => {
        imports += 1;
        throw new Error("must not import");
      },
    });
    assert.deepEqual(plugins, []);
    assert.equal(imports, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SaaS product has no install-time or compile-time plugin dependency", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pluginDependencies(packageJson), []);
  assert.deepEqual(staticPluginImports(new URL("../src", import.meta.url)), []);
});

test("SaaS product loads plugin modules from YAML", async () => {
  const directory = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "ragsystem-saas-plugins-"));
  const configPath = path.join(directory, "plugins.yaml");
  fs.writeFileSync(configPath, `
version: 1
plugins:
  - module: configured-saas-plugin
`, "utf8");
  try {
    const plugins = await createSaaSProductPlugins({
      configPath,
      importModule: async (specifier) => {
        const manifest = { id: specifier, version: "1.0.0" };
        return {
          backendPluginModule: {
            apiVersion: 1,
            manifest,
            create() {
              return { manifest, register() {} };
            },
          },
        };
      },
    });
    assert.deepEqual(pluginIds(plugins), ["configured-saas-plugin"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function pluginIds(plugins) {
  return plugins.map((plugin) => plugin.manifest.id);
}

function pluginDependencies(packageJson) {
  return Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies })
    .filter((name) => name.startsWith("@ragsystem/backend-plugin-"));
}

function staticPluginImports(rootUrl) {
  const root = fileURLToPath(rootUrl);
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => /\bfrom\s+["']@ragsystem\/backend-plugin-|\bimport\s*\(\s*["']@ragsystem\/backend-plugin-/.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file));
}
