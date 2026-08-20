#!/usr/bin/env node
/**
 * ragsystem 本地版插件安装器（写入用户级清单 <dataRoot>/plugins/plugins.yaml）。
 *
 * 用法（repo 根目录）：
 *   npm run plugin -- add <npm-spec | git-url | 本地路径>   # 安装
 *   npm run plugin -- list                                  # 查看已安装
 *   npm run plugin -- enable|disable <名称或序号>            # 启停
 *   npm run plugin -- remove <名称或序号>                    # 移除
 *   可选：--data-root <dir> 覆盖数据目录（默认 RAG_DATA_ROOT 或 ~/.ragsystem）
 *
 * 两种安装形态：
 *   - 本地路径（源码方式）：清单直接登记绝对路径，零拷贝——改源码、构建、重启后端即生效。
 *   - npm/git 规格：npm install --prefix <dataRoot>/plugins 安装，清单登记相对路径。
 * 后端启动时产品清单 + 用户清单合并装载；变更需重启后端生效。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { parse, stringify } from "yaml";

const ENTRY_CANDIDATES = ["module.js", "module.mjs", "dist/module.js", "dist/module.mjs", "src/module.ts"];

function usage(code = 1) {
  console.log(`用法: npm run plugin -- [--data-root <dir>] <command> [args]

命令:
  add <npm-spec|git-url|本地路径|插件.zip|module.js>   安装插件
      本地目录   = 源码方式，直接登记绝对路径（改完重启即生效）
      .zip/.js  = 分发产物安装（bundle-plugin 打包），拷入 modules/ 并登记
      其余       = npm/git 规格，npm install --prefix 安装
  list                              列出用户级已装插件
  enable <名称|序号>                启用
  disable <名称|序号>               禁用（后端不再 import）
  remove <名称|序号>                从清单移除（npm/modules 安装的一并清理）`);
  process.exit(code);
}

function parseArgs(argv) {
  let dataRoot = process.env.RAG_DATA_ROOT?.trim() || path.join(os.homedir(), ".ragsystem");
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--data-root") {
      dataRoot = argv[index + 1];
      if (!dataRoot) usage();
      index += 1;
    } else {
      rest.push(argv[index]);
    }
  }
  return { dataRoot: path.resolve(dataRoot), command: rest[0], args: rest.slice(1) };
}

function readList(listPath) {
  if (!fs.existsSync(listPath)) return { version: 1, plugins: [] };
  const document = parse(fs.readFileSync(listPath, "utf8"));
  if (!document || !Array.isArray(document.plugins)) {
    throw new Error(`用户插件清单格式无效: ${listPath}（期望 { version: 1, plugins: [...] }）`);
  }
  return document;
}

function writeList(listPath, document) {
  fs.mkdirSync(path.dirname(listPath), { recursive: true });
  fs.writeFileSync(listPath, stringify(document), "utf8");
}

/** 探测插件模块入口（约定 module.js；源码布局兜底 dist/、src/module.ts）。 */
function findEntryModule(directory) {
  for (const candidate of ENTRY_CANDIDATES) {
    const file = path.join(directory, ...candidate.split("/"));
    if (fs.existsSync(file)) return { entry: candidate, devOnly: candidate.endsWith(".ts") };
  }
  return null;
}

function isDirectorySpec(spec) {
  // Windows 盘符、POSIX 绝对路径、./ ../ 相对路径均视为本地路径
  return /^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../");
}

/** 从插件模块内容探测 manifest id（bundle 产物保留字面量或标识符引用；失败回退文件名）。 */
function detectPluginId(moduleFile) {
  try {
    const content = fs.readFileSync(moduleFile, "utf8");
    const literal = content.match(/manifest\s*:\s*\{[\s\S]{0,120}?id\s*:\s*(["'])([^"']+)\1/);
    if (literal) return literal[2];
    // esbuild 不会内联跨模块常量：id: PET_PLUGIN_ID → 反查 const PET_PLUGIN_ID = "..."
    const reference = content.match(/manifest\s*:\s*\{[\s\S]{0,120}?id\s*:\s*([A-Za-z_$][\w$]*)/);
    if (reference) {
      const definition = content.match(
        new RegExp(`(?:const|let|var)\\s+${reference[1]}\\s*=\\s*["']([^"']+)["']`),
      );
      if (definition) return definition[1];
    }
  } catch {
    // 读不到内容（二进制等）由调用方兜底
  }
  return null;
}

function safeName(raw) {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "plugin";
}

/**
 * 分发产物安装（bundle-plugin 产物）：module.js 单文件或 zip（内含 module.js + 可选资产）。
 * 暂存解包 → 定位入口（兼容 zip 内多一层包裹目录）→ 挪入 modules/<名>/ → 登记。
 */
async function installBundle(pluginsDir, spec) {
  const absolute = path.resolve(spec);
  const staging = path.join(pluginsDir, "modules", `.staging-${Date.now().toString(36)}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    if (absolute.toLowerCase().endsWith(".zip")) {
      const zip = await JSZip.loadAsync(fs.readFileSync(absolute));
      for (const entry of Object.keys(zip.files)) {
        if (zip.files[entry].dir) continue;
        const destination = path.join(staging, ...entry.split("/"));
        if (!destination.startsWith(staging + path.sep)) continue; // 防穿越
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, await zip.files[entry].async("nodebuffer"));
      }
    } else {
      // 单文件产物统一规范化为 module.js（入口探测与登记都按该约定）
      fs.copyFileSync(absolute, path.join(staging, "module.js"));
    }

    // 定位插件入口：暂存根或其唯一子目录
    let entryDir = staging;
    let entry = findEntryModule(staging);
    if (!entry) {
      const children = fs.readdirSync(staging).filter((name) => fs.statSync(path.join(staging, name)).isDirectory());
      if (children.length === 1) {
        entryDir = path.join(staging, children[0]);
        entry = findEntryModule(entryDir);
      }
    }
    if (!entry) throw new Error(`分发包里找不到插件入口（期望 module.js / module.mjs）: ${absolute}`);
    const entryFile = path.join(entryDir, ...entry.entry.split("/"));

    const name = safeName(detectPluginId(entryFile) ?? path.basename(absolute).replace(/\.(zip|js|mjs)$/i, ""));
    const moduleDir = path.join(pluginsDir, "modules", name);
    fs.rmSync(moduleDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(moduleDir), { recursive: true });
    fs.renameSync(entryDir, moduleDir);

    const module = `./modules/${name}/${entry.entry.endsWith(".ts") ? entry.entry : "module.js"}`;
    const listPath = path.join(pluginsDir, "plugins.yaml");
    const list = readList(listPath);
    if (list.plugins.some((item) => item.module === module)) {
      console.log(`已安装（跳过）: ${name}`);
      return;
    }
    list.plugins.push({ module, enabled: true });
    writeList(listPath, list);
    console.log(`已安装分发产物: ${name}（入口 ${module}）`);
    console.log("重启后端后生效（本地开发 tsx watch 会自动重载）。");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function parseNpmName(spec) {
  const trimmed = spec.replace(/^github:/, "");
  if (trimmed.startsWith("@")) {
    const match = trimmed.match(/^(@[^/]+)\/([^@/]+)/);
    return match ? `${match[1]}/${match[2]}` : trimmed;
  }
  return trimmed.split("@")[0].split("/").pop() || trimmed;
}

function runNpm(args, cwd) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} 失败:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function dependencyKeys(packageJsonPath) {
  if (!fs.existsSync(packageJsonPath)) return new Set();
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return new Set(Object.keys(pkg.dependencies ?? {}));
}

async function add(dataRoot, spec) {
  const pluginsDir = path.join(dataRoot, "plugins");
  const listPath = path.join(pluginsDir, "plugins.yaml");
  const list = readList(listPath);

  // 分发产物（.zip / module.js 单文件）
  if (isDirectorySpec(spec) && fs.existsSync(spec) && fs.statSync(spec).isFile() && /\.(zip|js|mjs)$/i.test(spec)) {
    await installBundle(pluginsDir, spec);
    return;
  }

  if (isDirectorySpec(spec)) {
    const absolute = path.resolve(spec);
    if (!fs.existsSync(absolute)) throw new Error(`路径不存在: ${absolute}`);
    let module;
    let devOnly = false;
    if (fs.statSync(absolute).isFile()) {
      module = absolute;
    } else {
      const found = findEntryModule(absolute);
      if (!found) throw new Error(`目录里找不到插件入口（尝试过 ${ENTRY_CANDIDATES.join(", ")}）: ${absolute}`);
      module = path.join(absolute, ...found.entry.split("/"));
      devOnly = found.devOnly;
    }
    if (list.plugins.some((item) => path.resolve(pluginsDir, item.module) === module)) {
      console.log(`已安装（跳过）: ${module}`);
      return;
    }
    list.plugins.push({ module, enabled: true });
    writeList(listPath, list);
    console.log(`已登记源码插件: ${module}`);
    if (devOnly) console.log("注意: 入口是 src/module.ts，仅开发模式（tsx）可加载；生产/桌面需要先构建 dist。");
  } else {
    fs.mkdirSync(pluginsDir, { recursive: true });
    const packageJsonPath = path.join(pluginsDir, "package.json");
    const before = dependencyKeys(packageJsonPath);
    console.log(`npm 安装中: ${spec}`);
    runNpm(["install", spec, "--no-audit", "--no-fund"], pluginsDir);
    const after = dependencyKeys(packageJsonPath);
    const added = [...after].filter((name) => !before.has(name));
    const name = added[0] ?? parseNpmName(spec);
    const packageDir = path.join(pluginsDir, "node_modules", name);
    const found = findEntryModule(packageDir);
    if (!found) throw new Error(`包已安装但找不到插件入口（期望 ${name}/module.js）: ${packageDir}`);
    const module = `./node_modules/${name}/${found.entry}`;
    if (list.plugins.some((item) => item.module === module)) {
      console.log(`已安装（跳过）: ${name}`);
      return;
    }
    list.plugins.push({ module, enabled: true });
    writeList(listPath, list);
    console.log(`已安装: ${name}（入口 ${module}）`);
  }
  console.log("重启后端后生效（本地开发 tsx watch 会自动重载）。");
}

function resolveEntry(list, target) {
  if (/^\d+$/.test(target)) {
    const index = Number(target) - 1;
    if (list.plugins[index]) return index;
    throw new Error(`序号越界: ${target}`);
  }
  const matches = list.plugins
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => item.module.includes(target));
  if (matches.length === 0) throw new Error(`未找到匹配 '${target}' 的插件`);
  if (matches.length > 1) throw new Error(`'${target}' 匹配多个插件，请用序号: ${matches.map(({ index }) => index + 1).join(", ")}`);
  return matches[0].index;
}

function list(dataRoot) {
  const listPath = path.join(dataRoot, "plugins", "plugins.yaml");
  const document = readList(listPath);
  if (document.plugins.length === 0) {
    console.log(`用户级清单为空（${listPath}）。\n安装: npm run plugin -- add <npm-spec|git-url|本地路径>`);
    return;
  }
  console.log(`用户级插件（${listPath}）:`);
  document.plugins.forEach((item, index) => {
    console.log(`  ${index + 1}. [${item.enabled === false ? "禁用" : "启用"}] ${item.module}`);
  });
}

function toggle(dataRoot, target, enabled) {
  const pluginsDir = path.join(dataRoot, "plugins");
  const listPath = path.join(pluginsDir, "plugins.yaml");
  const document = readList(listPath);
  const index = resolveEntry(document, target);
  document.plugins[index].enabled = enabled;
  writeList(listPath, document);
  console.log(`${enabled ? "启用" : "禁用"}: ${document.plugins[index].module}\n重启后端后生效。`);
}

function remove(dataRoot, target) {
  const pluginsDir = path.join(dataRoot, "plugins");
  const listPath = path.join(pluginsDir, "plugins.yaml");
  const document = readList(listPath);
  const index = resolveEntry(document, target);
  const [removed] = document.plugins.splice(index, 1);
  writeList(listPath, document);
  console.log(`已移除: ${removed.module}`);
  // modules/ 分发产物：清掉拷贝目录（我们拥有这份拷贝）
  const modulesMatch = typeof removed.module === "string" && removed.module.match(/^\.\/modules\/([^/]+)\//);
  if (modulesMatch) {
    const moduleDir = path.join(pluginsDir, "modules", modulesMatch[1]);
    if (fs.existsSync(moduleDir)) {
      fs.rmSync(moduleDir, { recursive: true, force: true });
      console.log(`已删除: ${path.relative(dataRoot, moduleDir)}`);
    }
  }
  // npm 安装的条目顺带 uninstall；源码登记（绝对路径）只清清单，不动源码
  const npmMatch = typeof removed.module === "string" && removed.module.match(/node_modules\/((@[^/]+)\/[^/]+|[^/]+)/);
  if (npmMatch && fs.existsSync(path.join(pluginsDir, "package.json"))) {
    try {
      runNpm(["uninstall", npmMatch[1], "--no-audit", "--no-fund"], pluginsDir);
      console.log(`npm uninstall: ${npmMatch[1]}`);
    } catch (error) {
      console.log(`npm uninstall 失败（清单已清理，可忽略）: ${error.message.split("\n")[0]}`);
    }
  }
  console.log("重启后端后生效。");
}

const { dataRoot, command, args } = parseArgs(process.argv.slice(2));
try {
  if (command === "add" && args.length === 1) await add(dataRoot, args[0]);
  else if (command === "list") list(dataRoot);
  else if ((command === "enable" || command === "disable") && args.length === 1) toggle(dataRoot, args[0], command === "enable");
  else if (command === "remove" && args.length === 1) remove(dataRoot, args[0]);
  else usage();
} catch (error) {
  console.error(`错误: ${error.message}`);
  process.exit(1);
}
