import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoots = [
  path.join(packageRoot, "skills"),
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

test("spatial skill scripts use data-first file outputs", () => {
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
  const visualizationScripts = path.join(packageRoot, "skills", "visualization", "scripts");
  const emergencyScripts = path.join(packageRoot, "skills", "emergency-decision-support", "scripts");
  assert.equal(fs.existsSync(path.join(visualizationScripts, ["create", "map.py"].join("_"))), false);
  assert.equal(fs.existsSync(path.join(visualizationScripts, ["create", "bindmap.py"].join("_"))), false);
  assert.equal(fs.existsSync(path.join(emergencyScripts, ["create", "risk_map.py"].join("_"))), false);
});

test("GeoJSON analysis scripts return a direct generic file object", () => {
  const scripts = path.join(packageRoot, "skills", "geojson-analysis", "scripts");
  assert.equal(fs.existsSync(path.join(scripts, "_file.py")), true);
  assert.equal(fs.existsSync(path.join(scripts, ["_", "artifact.py"].join(""))), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geojson-file-contract-"));
  try {
    const input = path.join(root, "input.geojson");
    fs.writeFileSync(input, JSON.stringify({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        geometry: { type: "Point", coordinates: [108.37, 22.82] },
        properties: { population: 2_000_000 },
      }],
    }));
    const python = process.env.RAGSYSTEM_PYTHON?.trim() || "python";
    const result = spawnSync(python, [
      path.join(scripts, "geojson_filter.py"),
      "--data", input,
      "--where", "population gt 1000000",
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.file.path, "geojson-filter.geojson");
    assert.equal(payload.file.media_type, "application/geo+json");
    assert.ok(payload.file.size > 0);
    assert.equal(payload.file.metadata.spatial.crs, "EPSG:4326");
    assert.equal(Object.hasOwn(payload.file, "file"), false);
    assert.equal(Object.hasOwn(payload.file, "assets"), false);
    assert.equal(fs.existsSync(path.join(root, payload.file.path)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("spatial file helpers do not return nested or legacy file envelopes", () => {
  const helpers = [
    ["gis-bindmap", "_shared.py"],
    ["kg-advanced-query", "geo_export.py"],
    ["raster-spatial-analysis", "_shared.py"],
    ["spatial-conversion", "_shared.py"],
    ["spatial-data-management", "_shared.py"],
    ["terrain-hydrology-analysis", "_shared.py"],
    ["vector-spatial-analysis", "_shared.py"],
  ];
  for (const [skill, script] of helpers) {
    const source = fs.readFileSync(path.join(packageRoot, "skills", skill, "scripts", script), "utf8");
    assert.doesNotMatch(source, /"file"\s*:\s*\{\s*"path"/, `${skill}/${script} still wraps file.path`);
    assert.doesNotMatch(source, /"schema_version"|"assets"\s*:|"presentations"\s*:/, `${skill}/${script} still uses a legacy file envelope`);
  }

  for (const entry of fs.readdirSync(path.join(packageRoot, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(packageRoot, "skills", entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, "utf8");
    assert.doesNotMatch(content, /File V2|GeoJSON Asset|RAGSYSTEM_ARTIFACT_OUTPUT_DIR/i, entry.name);
    assert.doesNotMatch(content, /```bash\s+python\s+scripts\//i, entry.name);
  }
});
