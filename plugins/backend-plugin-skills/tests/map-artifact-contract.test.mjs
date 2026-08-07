import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoots = [
  path.join(packageRoot, "skills"),
  path.resolve(packageRoot, "..", "backend-plugin-artifacts", "skills"),
];
const forbidden = [
  ["map", "geojson"].join("."),
  ["map", "raster"].join("."),
  ["create", "map"].join("_"),
  ["create", "bindmap"].join("_"),
  ["bindmap", "ready"].join("_"),
  "viz_" + "type",
  '"surface"' + ': "map"',
  "Map" + "Renderer",
  "map" + "Data",
];

function pythonFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && [".venv", "node_modules", "dist"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...pythonFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".py")) files.push(absolute);
  }
  return files;
}

test("map-producing skill scripts use data-first Artifact V2", () => {
  const violations = [];
  for (const root of skillRoots) {
    for (const file of pythonFiles(root)) {
      const source = fs.readFileSync(file, "utf8");
      for (const marker of forbidden) {
        if (source.includes(marker)) violations.push(`${path.relative(packageRoot, file)}: ${marker}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("legacy map-generation entry points are removed", () => {
  const visualizationScripts = path.join(packageRoot, "..", "backend-plugin-artifacts", "skills", "visualization", "scripts");
  const emergencyScripts = path.join(packageRoot, "skills", "emergency-decision-support", "scripts");
  assert.equal(fs.existsSync(path.join(visualizationScripts, ["create", "map.py"].join("_"))), false);
  assert.equal(fs.existsSync(path.join(visualizationScripts, ["create", "bindmap.py"].join("_"))), false);
  assert.equal(fs.existsSync(path.join(emergencyScripts, ["create", "risk_map.py"].join("_"))), false);
});
