import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const outputRoot = path.join(desktopRoot, "dist", "backend-local");

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const pluginConfigPath = path.join(repoRoot, "backend-local", "backend.plugins.yaml");
const pluginConfig = parseYaml(fs.readFileSync(pluginConfigPath, "utf8"));
if (!pluginConfig || !Array.isArray(pluginConfig.plugins)) {
  throw new Error(`Invalid backend plugin manifest: ${pluginConfigPath}`);
}

await build({
  entryPoints: [path.join(repoRoot, "backend-local", "src", "main.ts")],
  outfile: path.join(outputRoot, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  packages: "bundle",
  external: ["node:*", "sqlite-vec"],
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

const pluginEntryPoints = {};
for (const [index, plugin] of pluginConfig.plugins.entries()) {
  if (!plugin || typeof plugin.module !== "string" || !plugin.module.trim()) {
    throw new Error(`Invalid backend plugin module at plugins[${index}]`);
  }
  if (plugin.enabled === false) continue;
  const entryName = `plugin-${index}`;
  pluginEntryPoints[entryName] = resolvePluginEntry(plugin.module, pluginConfigPath);
  plugin.module = `./plugin-modules/${entryName}.js`;
}
if (Object.keys(pluginEntryPoints).length > 0) {
  await build({
    entryPoints: pluginEntryPoints,
    outdir: path.join(outputRoot, "plugin-modules"),
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    external: ["node:*", "sqlite-vec", "sqlite-vec-*"],
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);',
    },
  });
}
fs.writeFileSync(
  path.join(outputRoot, "backend.plugins.yaml"),
  stringifyYaml(pluginConfig),
  "utf8",
);

copyPackage("sqlite-vec", path.join(repoRoot, "node_modules", "sqlite-vec"));
copyPackage(
  "sqlite-vec-windows-x64",
  path.join(repoRoot, "node_modules", "sqlite-vec-windows-x64"),
);
fs.cpSync(
  path.join(repoRoot, "plugins", "backend-plugin-skills", "skills"),
  path.join(outputRoot, "plugin-modules", "plugin-assets", "skills"),
  { recursive: true },
);
// 桌宠 thumb 动画（约 35MB，不入 git）：已 fetch 时随包拷贝，缺失时跳过（宠物自动隐藏）
const petAssetsSource = path.join(repoRoot, "plugins", "backend-plugin-pet", "assets");
if (fs.existsSync(petAssetsSource)) {
  fs.cpSync(
    petAssetsSource,
    path.join(outputRoot, "plugin-modules", "plugin-assets", "pet"),
    { recursive: true },
  );
}
// 桌宠前端 bundle（ui/dist，npm run build:ui 产物）：缺失时跳过（bundle 404，前端降级）
const petUiSource = path.join(repoRoot, "plugins", "backend-plugin-pet", "ui", "dist");
if (fs.existsSync(petUiSource)) {
  fs.cpSync(
    petUiSource,
    path.join(outputRoot, "plugin-modules", "plugin-assets", "pet", "ui"),
    { recursive: true },
  );
}
fs.writeFileSync(
  path.join(outputRoot, "package.json"),
  `${JSON.stringify({ name: "ragsystem-desktop-backend", private: true, type: "module" }, null, 2)}\n`,
  "utf8",
);

function copyPackage(name, source) {
  if (!fs.existsSync(source)) {
    throw new Error(`Missing runtime package ${name}: ${source}`);
  }
  fs.cpSync(source, path.join(outputRoot, "node_modules", name), { recursive: true });
}

function resolvePluginEntry(specifier, configPath) {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (path.isAbsolute(specifier)) return specifier;
  if (/^\.\.?[\\/]/.test(specifier)) {
    return path.resolve(path.dirname(configPath), specifier);
  }
  return specifier;
}

console.log(`Prepared TypeScript backend at ${outputRoot}`);
