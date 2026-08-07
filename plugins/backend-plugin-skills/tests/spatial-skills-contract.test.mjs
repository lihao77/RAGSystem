import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(packageRoot, "skills");

const skillScripts = {
  "spatial-data-management": ["describe_vector", "describe_raster", "list_layers", "validate_crs", "define_projection", "repair_geometry", "copy_features", "delete_fields", "rename_fields", "calculate_field", "summary_statistics"],
  "vector-spatial-analysis": ["inspect_vector", "project", "reproject", "define_projection", "buffer", "clip", "intersect", "union", "erase", "identity", "dissolve", "merge", "append", "spatial_join", "select", "select_by_location", "near", "repair_geometry", "multipart_to_singlepart", "calculate_field", "summary_statistics", "export"],
  "raster-spatial-analysis": ["describe_raster", "project_raster", "clip_raster", "extract_by_mask", "resample_raster", "raster_calculator", "reclassify", "set_nodata", "fill_nodata", "aggregate_raster", "focal_statistics", "zonal_statistics", "raster_statistics", "cell_statistics", "mosaic"],
  "spatial-conversion": ["rasterize", "polygonize", "vector_to_geojson", "raster_to_cog"],
  "terrain-hydrology-analysis": ["slope", "aspect", "hillshade", "contour", "fill_sinks", "flow_direction", "flow_accumulation", "watershed"],
};

test("GIS capabilities are separated into domain Skills with one public script per operation", () => {
  for (const [skillName, tools] of Object.entries(skillScripts)) {
    const root = path.join(skillsRoot, skillName);
    assert.equal(fs.existsSync(path.join(root, "SKILL.md")), true, `${skillName} 缺少 SKILL.md`);
    const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
    assert.doesNotMatch(skill.toLowerCase(), new RegExp("arc" + "py", "i"));
    for (const tool of tools) {
      assert.equal(fs.existsSync(path.join(root, "scripts", `${tool}.py`)), true, `${skillName} 缺少独立入口: ${tool}`);
      assert.match(skill, new RegExp(`${tool}\\.py`));
    }
    assert.doesNotMatch(skill, /--operation|--tool/);
  }
});

test("raster expression evaluator is AST-whitelisted", () => {
  const source = fs.readFileSync(path.join(skillsRoot, "raster-spatial-analysis", "scripts", "_raster.py"), "utf8");
  assert.match(source, /def _evaluate/);
  assert.doesNotMatch(source, /(?<!literal_)eval\s*\(/);
  assert.match(source, /ast\.Call/);
});

test("spatial file and map contracts are documented", () => {
  const vector = fs.readFileSync(path.join(skillsRoot, "vector-spatial-analysis", "SKILL.md"), "utf8");
  const raster = fs.readFileSync(path.join(skillsRoot, "raster-spatial-analysis", "SKILL.md"), "utf8");
  const visualization = fs.readFileSync(path.join(skillsRoot, "geospatial-visualization", "SKILL.md"), "utf8");
  for (const content of [vector, raster]) {
    assert.match(content, /file\.path/);
    assert.match(content, /map_add_file_layer/);
  }
  assert.match(visualization, /map_add_file_layer/);
});
