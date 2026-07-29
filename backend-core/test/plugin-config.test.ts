import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadBackendPluginConfig,
  loadConfiguredBackendPlugins,
  parseBackendPluginConfig,
} from "../src/plugins/plugin-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("backend plugin YAML configuration", () => {
  it("preserves order, resolves relative modules, and interpolates enabled config", () => {
    const sourcePath = path.resolve("fixtures/config/backend.plugins.yaml");
    const specs = parseBackendPluginConfig(`
version: 1
plugins:
  - module: "@company/backend-plugin-example/module.js"
    config:
      endpoint: "https://example.test/${"${EXAMPLE_PATH}"}"
      token: "${"${EXAMPLE_TOKEN}"}"
  - module: "../plugins/local-plugin.js"
  - module: "disabled-plugin"
    enabled: false
    config:
      token: "${"${MISSING_WHILE_DISABLED}"}"
`, {
      sourcePath,
      env: { EXAMPLE_PATH: "v1", EXAMPLE_TOKEN: "secret-value" },
    });

    expect(specs).toEqual([
      {
        module: "@company/backend-plugin-example/module.js",
        config: { endpoint: "https://example.test/v1", token: "secret-value" },
      },
      {
        module: pathToFileURL(path.resolve(path.dirname(sourcePath), "../plugins/local-plugin.js")).href,
      },
      { module: "disabled-plugin", enabled: false },
    ]);
  });

  it("rejects unknown fields, duplicate modules, and missing environment variables", () => {
    expect(() => parseBackendPluginConfig(`
version: 1
plugins: []
unexpected: true
`, { sourcePath: "backend.plugins.yaml" })).toThrow("Unrecognized key(s) in object: 'unexpected'");

    expect(() => parseBackendPluginConfig(`
version: 1
plugins:
  - module: duplicate
  - module: duplicate
`, { sourcePath: "backend.plugins.yaml" })).toThrow("Duplicate backend plugin module 'duplicate'");

    expect(() => parseBackendPluginConfig(`
version: 1
plugins:
  - module: example
    config:
      token: "${"${MISSING_TOKEN}"}"
`, { sourcePath: "backend.plugins.yaml", env: {} })).toThrow("missing environment variable 'MISSING_TOKEN'");
  });

  it("loads an explicit file and reports missing files with their resolved path", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "plugins.yml"), "version: 1\nplugins: []\n", "utf8");

    await expect(loadBackendPluginConfig("plugins.yml", { cwd: directory })).resolves.toEqual([]);
    await expect(loadBackendPluginConfig("missing.yml", { cwd: directory }))
      .rejects.toThrow(path.join(directory, "missing.yml"));
  });

  it("requires the default YAML file and supports an explicit path", async () => {
    const directory = await temporaryDirectory();
    await expect(loadConfiguredBackendPlugins({ cwd: directory }))
      .rejects.toThrow(path.join(directory, "backend.plugins.yaml"));

    await writeFile(path.join(directory, "backend.plugins.yaml"), `
version: 1
plugins:
  - module: default-module
`, "utf8");
    const imported: string[] = [];
    const importModule = async (specifier: string) => {
      imported.push(specifier);
      const manifest = { id: specifier, version: "1.0.0" };
      return {
        backendPluginModule: {
          apiVersion: 1,
          manifest,
          create: () => ({ manifest, register() {} }),
        },
      };
    };
    await expect(loadConfiguredBackendPlugins({ cwd: directory, importModule }))
      .resolves.toHaveLength(1);
    expect(imported).toEqual(["default-module"]);

    await writeFile(path.join(directory, "explicit.yml"), `
version: 1
plugins:
  - module: explicit-module
`, "utf8");
    await expect(loadConfiguredBackendPlugins({
      cwd: directory,
      configPath: "explicit.yml",
      importModule,
    })).resolves.toHaveLength(1);
    expect(imported).toEqual(["default-module", "explicit-module"]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ragsystem-plugin-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
