import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createLocalProductPlugins } from "../dist/product-plugins.js";

const PRODUCT_IDS = [
  "@ragsystem/backend-plugin-execution-tools",
  "@ragsystem/backend-plugin-document-tools",
  "@ragsystem/backend-plugin-daemon-feishu",
  "@ragsystem/backend-plugin-scheduler",
  "@ragsystem/backend-plugin-knowledge",
  "@ragsystem/backend-plugin-memory",
  "@ragsystem/backend-plugin-mcp",
  "@ragsystem/backend-plugin-skills",
  "@ragsystem/backend-plugin-agent-builder",
  "@ragsystem/backend-plugin-widget",
  "@ragsystem/backend-plugin-image-tools",
  "@ragsystem/backend-plugin-pet",
  "@ragsystem/backend-plugin-local-scenes",
];

function pluginIds(plugins) {
  return plugins.map((plugin) => plugin.manifest.id);
}

function makeTemp() {
  return fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "ragsystem-user-plugins-"));
}

test("用户级清单缺失时仅装载产品插件", async () => {
  const directory = makeTemp();
  try {
    const plugins = await createLocalProductPlugins({
      userPluginsPath: path.join(directory, "plugins", "plugins.yaml"),
    });
    assert.deepEqual(pluginIds(plugins), PRODUCT_IDS);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("用户级清单的插件与产品插件合并装载", async () => {
  const directory = makeTemp();
  try {
    const moduleFile = path.join(directory, "my-plugin.module.mjs");
    fs.writeFileSync(moduleFile, `
export const backendPluginModule = {
  apiVersion: 1,
  manifest: { id: "user-test-plugin", version: "0.1.0" },
  create: () => ({ manifest: { id: "user-test-plugin", version: "0.1.0" }, register() {} }),
};
`, "utf8");
    const userPluginsPath = path.join(directory, "plugins", "plugins.yaml");
    fs.mkdirSync(path.dirname(userPluginsPath), { recursive: true });
    fs.writeFileSync(userPluginsPath, `version: 1\nplugins:\n  - module: ${moduleFile.replace(/\\/g, "/")}\n    enabled: true\n`, "utf8");

    const plugins = await createLocalProductPlugins({ userPluginsPath });
    assert.deepEqual(pluginIds(plugins), [...PRODUCT_IDS, "user-test-plugin"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("用户级清单的禁用条目不会被导入", async () => {
  const directory = makeTemp();
  try {
    const userPluginsPath = path.join(directory, "plugins.yaml");
    fs.writeFileSync(userPluginsPath, "version: 1\nplugins:\n  - module: anywhere\n    enabled: false\n", "utf8");
    let userImports = 0;
    const plugins = await createLocalProductPlugins({
      userPluginsPath,
      // 只拦用户条目（"anywhere"）；产品插件走真实导入
      importModule: async (specifier) => {
        if (specifier === "anywhere") {
          userImports += 1;
          throw new Error("must not import");
        }
        return import(specifier);
      },
    });
    assert.deepEqual(pluginIds(plugins), PRODUCT_IDS);
    assert.equal(userImports, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
