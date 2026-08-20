import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

/** CLI 冒烟：源码方式与分发产物（单文件/zip）的 add → list → remove 全流程（不触网）。 */

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "plugin-manager.mjs",
);

function makeTemp() {
  return fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), "ragsystem-plugin-cli-"));
}

function run(dataRoot, args) {
  return execFileSync(process.execPath, [scriptPath, "--data-root", dataRoot, ...args], {
    encoding: "utf8",
  });
}

test("源码方式安装：add 登记→list 可见→disable/enable→remove 清单清空", () => {
  const dataRoot = makeTemp();
  const pluginDir = path.join(makeTemp(), "my-plugin");
  try {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "module.js"), "export const backendPluginModule = 1;\n", "utf8");

    run(dataRoot, ["add", pluginDir]);
    const listPath = path.join(dataRoot, "plugins", "plugins.yaml");
    assert.match(fs.readFileSync(listPath, "utf8"), /my-plugin.*module\.js/);

    const listing = run(dataRoot, ["list"]);
    assert.match(listing, /1\. \[启用\]/);

    run(dataRoot, ["disable", "1"]);
    assert.match(run(dataRoot, ["list"]), /\[禁用\]/);
    run(dataRoot, ["enable", "my-plugin"]);
    assert.match(run(dataRoot, ["list"]), /\[启用\]/);

    // 源码登记的 remove 只清清单，不动源码目录
    run(dataRoot, ["remove", "1"]);
    assert.doesNotMatch(fs.readFileSync(listPath, "utf8"), /my-plugin/);
    assert.ok(fs.existsSync(path.join(pluginDir, "module.js")), "源码目录不应被删除");
    assert.match(run(dataRoot, ["list"]), /用户级清单为空/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("add 对目录缺入口与路径不存在给出明确错误", () => {
  const dataRoot = makeTemp();
  const emptyDir = makeTemp();
  try {
    assert.throws(() => run(dataRoot, ["add", path.join(emptyDir, "nope")]), /路径不存在/);
    fs.mkdirSync(path.join(emptyDir, "no-entry"), { recursive: true });
    assert.throws(() => run(dataRoot, ["add", path.join(emptyDir, "no-entry")]), /找不到插件入口/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

const BUNDLED_MODULE = `
export const backendPluginModule = {
  apiVersion: 1,
  manifest: { id: "demo-bundled-plugin", version: "0.1.0" },
  create: () => ({ manifest: { id: "demo-bundled-plugin", version: "0.1.0" }, register() {} }),
};
`;

test("分发产物安装：module.js 单文件（id 从产物内容探测）", () => {
  const dataRoot = makeTemp();
  const source = makeTemp();
  try {
    const bundleFile = path.join(source, "my-bundle.js");
    fs.writeFileSync(bundleFile, BUNDLED_MODULE, "utf8");

    run(dataRoot, ["add", bundleFile]);
    const entry = path.join(dataRoot, "plugins", "modules", "demo-bundled-plugin", "module.js");
    assert.ok(fs.existsSync(entry), "应拷入 modules/<探测id>/module.js");
    const yaml = fs.readFileSync(path.join(dataRoot, "plugins", "plugins.yaml"), "utf8");
    assert.match(yaml, /\.\/modules\/demo-bundled-plugin\/module\.js/);

    run(dataRoot, ["remove", "demo-bundled-plugin"]);
    assert.ok(!fs.existsSync(entry), "remove 应删除 modules 拷贝目录");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test("分发产物安装：zip（含包裹目录与资产）", async () => {
  const dataRoot = makeTemp();
  const source = makeTemp();
  try {
    const zip = new JSZip();
    const wrapped = zip.folder("my-plugin-1.0.0");
    wrapped.file("module.js", BUNDLED_MODULE);
    wrapped.file("assets/thumb/idle.webm", "fake-webm");
    const zipFile = path.join(source, "my-plugin.zip");
    fs.writeFileSync(zipFile, await zip.generateAsync({ type: "nodebuffer" }));

    run(dataRoot, ["add", zipFile]);
    const moduleDir = path.join(dataRoot, "plugins", "modules", "demo-bundled-plugin");
    assert.ok(fs.existsSync(path.join(moduleDir, "module.js")), "入口应位于 modules/<id>/（剥掉包裹目录）");
    assert.ok(fs.existsSync(path.join(moduleDir, "assets", "thumb", "idle.webm")), "资产应随包解压");
    const yaml = fs.readFileSync(path.join(dataRoot, "plugins", "plugins.yaml"), "utf8");
    assert.match(yaml, /\.\/modules\/demo-bundled-plugin\/module\.js/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});
