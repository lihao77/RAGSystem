#!/usr/bin/env node
/**
 * 插件作者打包脚本：把插件源码 esbuild 成自包含单文件（与桌面打包同构），
 * 连同可选资产打成可分发的 zip——用户端 `npm run plugin -- add <zip>` 即装。
 *
 * 用法（repo 根目录，或插件的 package.json scripts 里引用）：
 *   npm run bundle-plugin -- <插件目录> [--asset <源目录:目标目录>]... [--out <输出目录>]
 *
 * 示例：
 *   npm run bundle-plugin -- plugins/backend-plugin-pet --asset assets:assets --asset ui/dist:ui
 *   → release/backend-plugin-pet-0.1.0.zip（内含 module.js + assets/ + ui/）
 *
 * 产物布局约定：module.js 与资产目录平级。插件内解析资产时优先
 * `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "<目标目录>")`，
 * 再兜底 workspace 布局（与 pet 的双布局探测一致）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import JSZip from "jszip";

const BANNER = 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);';

function usage(code = 1) {
  console.log(`用法: npm run bundle-plugin -- <插件目录> [--asset <源:目标>]... [--out <输出目录>]`);
  process.exit(code);
}

const argv = process.argv.slice(2);
const positional = [];
const assets = [];
let outDir;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--asset") {
    const pair = argv[index + 1];
    if (!pair || !pair.includes(":")) usage();
    const separator = pair.indexOf(":");
    assets.push({ source: pair.slice(0, separator), destination: pair.slice(separator + 1) });
    index += 1;
  } else if (argv[index] === "--out") {
    outDir = argv[index + 1];
    if (!outDir) usage();
    index += 1;
  } else {
    positional.push(argv[index]);
  }
}
const pluginDir = positional[0] && path.resolve(positional[0]);
if (!pluginDir || !fs.existsSync(pluginDir)) usage();

const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
const artifactName = `${pkg.name?.replace(/^@ragsystem\//, "") ?? "plugin"}-${pkg.version ?? "0.0.0"}`;
const outputRoot = path.resolve(outDir ?? path.join(pluginDir, "release"));

const entry =
  fs.existsSync(path.join(pluginDir, "src", "module.ts")) ? path.join(pluginDir, "src", "module.ts")
  : fs.existsSync(path.join(pluginDir, "src", "module.js")) ? path.join(pluginDir, "src", "module.js")
  : fs.existsSync(path.join(pluginDir, "module.js")) ? path.join(pluginDir, "module.js")
  : null;
if (!entry) {
  console.error(`错误: 找不到插件入口（期望 src/module.ts 或 module.js）: ${pluginDir}`);
  process.exit(1);
}

fs.mkdirSync(outputRoot, { recursive: true });
await build({
  entryPoints: { module: entry },
  outdir: outputRoot,
  outExtension: { ".js": ".tmp.js" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  external: ["node:*", "sqlite-vec", "sqlite-vec-*"],
  banner: { js: BANNER },
  logLevel: "silent",
});

const zip = new JSZip();
zip.file("module.js", fs.readFileSync(path.join(outputRoot, "module.tmp.js")));
for (const asset of assets) {
  const source = path.resolve(pluginDir, asset.source);
  if (!fs.existsSync(source)) {
    console.error(`错误: 资产目录不存在: ${source}`);
    process.exit(1);
  }
  addDirectoryToZip(zip, asset.destination.replace(/^\/+|\/+$/g, ""), source);
}
const zipPath = path.join(outputRoot, `${artifactName}.zip`);
fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
fs.rmSync(path.join(outputRoot, "module.tmp.js"), { force: true });

const sha256 = createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
console.log(`已打包: ${zipPath}`);
console.log(`sha256: ${sha256}`);
console.log(`包含: module.js${assets.length ? " + " + assets.map((asset) => `${asset.source}→${asset.destination}`).join(", ") : ""}`);
console.log(`安装: npm run plugin -- add ${zipPath} --sha256 ${sha256}`);

function addDirectoryToZip(zip, prefix, directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const entry = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(file).isDirectory()) addDirectoryToZip(zip, entry, file);
    else zip.file(entry, fs.readFileSync(file));
  }
}
