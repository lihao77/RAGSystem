import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(packageRoot, "skills", "nc-analysis");
const scriptPath = path.join(skillRoot, "scripts", "render_nc.py");
const pythonCandidates = [
  process.env.RAGSYSTEM_PYTHON,
  path.join(skillRoot, ".venv", "Scripts", "python.exe"),
  "python",
].filter(Boolean);

function findPython() {
  for (const executable of pythonCandidates) {
    const result = spawnSync(executable, ["-c", "import netCDF4, numpy, PIL"], { encoding: "utf8" });
    if (result.status === 0) return executable;
  }
  return null;
}

const python = findPython();

test("render_nc writes the selected output files without raster data in JSON", {
  skip: python ? false : "当前 Python 环境缺少 netCDF4、NumPy 或 Pillow",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-nc-contract-"));
  try {
    const inputPath = path.join(root, "sample.nc");
    const outputDirectory = path.join(root, "output");
    fs.mkdirSync(outputDirectory);
    const createDataset = [
      "import sys",
      "import numpy as np",
      "from netCDF4 import Dataset",
      "with Dataset(sys.argv[1], 'w') as ds:",
      "    ds.createDimension('lat', 3)",
      "    ds.createDimension('lon', 4)",
      "    lat = ds.createVariable('lat', 'f4', ('lat',))",
      "    lon = ds.createVariable('lon', 'f4', ('lon',))",
      "    lat.standard_name = 'latitude'",
      "    lon.standard_name = 'longitude'",
      "    lat.units = 'degrees_north'",
      "    lon.units = 'degrees_east'",
      "    lat[:] = [10, 20, 30]",
      "    lon[:] = [100, 110, 120, 130]",
      "    value = ds.createVariable('temperature', 'f4', ('lat', 'lon'))",
      "    value.long_name = '海温'",
      "    value.units = 'degC'",
      "    value[:] = np.arange(12, dtype='f4').reshape(3, 4)",
    ].join("\n");
    const createResult = spawnSync(python, ["-c", createDataset, inputPath], { encoding: "utf8" });
    assert.equal(createResult.status, 0, createResult.stderr);

    const renderResult = spawnSync(
      python,
      [scriptPath, "--file", inputPath, "--variable", "temperature"],
      {
        encoding: "utf8",
        cwd: outputDirectory,
      },
    );
    assert.equal(renderResult.status, 0, renderResult.stderr);
    const payload = JSON.parse(renderResult.stdout);
    const artifact = payload.file;
    assert.equal(artifact.schema_version, 2);
    assert.equal(artifact.kind, "raster.preview");
    assert.ok(Array.isArray(artifact.assets));
    assert.ok(Array.isArray(artifact.presentations));
    assert.deepEqual(artifact.presentations, []);
    assert.equal(artifact.metadata.spatial.crs, "EPSG:4326");
    assert.deepEqual(artifact.metadata.spatial.bounds, [95, 5, 135, 35]);
    assert.equal(artifact.assets[0].filename, "temperature-raster.png");
    assert.equal(Object.hasOwn(artifact.assets[0], "data_base64"), false);
    assert.equal(Object.hasOwn(payload.data.raster, "values"), false);
    assert.equal(Object.hasOwn(payload.data.raster, "valid_counts"), false);
    const png = fs.readFileSync(path.join(outputDirectory, artifact.assets[0].filename));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const inspectResult = spawnSync(
      python,
      [path.join(skillRoot, "scripts", "inspect_nc.py"), "--file", inputPath],
      { encoding: "utf8", cwd: outputDirectory },
    );
    assert.equal(inspectResult.status, 0, inspectResult.stderr);
    const inspection = JSON.parse(inspectResult.stdout);
    assert.equal(inspection.file.schema_version, 2);
    assert.equal(inspection.file.kind, "vector.dataset");
    assert.ok(Array.isArray(inspection.file.presentations));
    assert.deepEqual(inspection.file.presentations, []);
    assert.equal(inspection.file.assets[0].media_type, "application/geo+json");
    assert.equal(inspection.file.metadata.spatial.crs, "EPSG:4326");
    assert.deepEqual(inspection.file.metadata.spatial.bounds, [95, 5, 135, 35]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
