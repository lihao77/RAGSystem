import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const outputRoot = path.join(desktopRoot, "dist", "backend-local");

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

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

copyPackage("sqlite-vec", path.join(repoRoot, "node_modules", "sqlite-vec"));
copyPackage(
  "sqlite-vec-windows-x64",
  path.join(repoRoot, "node_modules", "sqlite-vec-windows-x64"),
);
fs.cpSync(path.join(repoRoot, "backend-core", "skills"), path.join(outputRoot, "skills"), {
  recursive: true,
});
fs.cpSync(
  path.join(repoRoot, "plugins", "backend-plugin-artifacts", "skills"),
  path.join(outputRoot, "plugin-assets", "artifacts", "skills"),
  { recursive: true },
);
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

console.log(`Prepared TypeScript backend at ${outputRoot}`);
