import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolvePluginAssetDir } from "../src/plugins/plugin-assets.js";

function makeLayout(build: (root: string) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-asset-layout-"));
  build(root);
  return root;
}

describe("resolvePluginAssetDir", () => {
  it("probes distributed layout (sibling of module.js) first", () => {
    const root = makeLayout((dir) => {
      fs.mkdirSync(path.join(dir, "assets", "thumb"), { recursive: true });
      fs.mkdirSync(path.join(dir, "pkg", "assets", "thumb"), { recursive: true });
    });
    try {
      const resolved = resolvePluginAssetDir({
        moduleUrl: pathToFileURL(path.join(root, "module.js")).href,
        relative: "assets/thumb",
        pluginId: "@ragsystem/backend-plugin-pet",
      });
      expect(resolved).toBe(path.join(root, "assets", "thumb"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to workspace layout and honors workspaceRelative override", () => {
    const root = makeLayout((dir) => {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.mkdirSync(path.join(dir, "ui", "dist"), { recursive: true });
    });
    try {
      const resolved = resolvePluginAssetDir({
        moduleUrl: pathToFileURL(path.join(root, "src", "module.ts")).href,
        relative: "ui",
        workspaceRelative: "ui/dist",
        pluginId: "@ragsystem/backend-plugin-pet",
      });
      expect(resolved).toBe(path.join(root, "ui", "dist"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("probes desktop layout with the plugin short id", () => {
    const root = makeLayout((dir) => {
      fs.mkdirSync(path.join(dir, "plugin-modules"), { recursive: true });
      fs.mkdirSync(path.join(dir, "plugin-modules", "plugin-assets", "backend-plugin-pet", "assets", "thumb"), { recursive: true });
    });
    try {
      const resolved = resolvePluginAssetDir({
        moduleUrl: pathToFileURL(path.join(root, "plugin-modules", "plugin-11.js")).href,
        relative: "assets/thumb",
        pluginId: "@ragsystem/backend-plugin-pet",
      });
      expect(resolved).toBe(path.join(root, "plugin-modules", "plugin-assets", "backend-plugin-pet", "assets", "thumb"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns the workspace candidate when nothing exists (caller renders empty state)", () => {
    const root = makeLayout(() => undefined);
    try {
      const resolved = resolvePluginAssetDir({
        moduleUrl: pathToFileURL(path.join(root, "dist", "module.js")).href,
        relative: "assets/thumb",
        pluginId: "pet",
      });
      expect(resolved).toBe(path.join(root, "assets", "thumb"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
