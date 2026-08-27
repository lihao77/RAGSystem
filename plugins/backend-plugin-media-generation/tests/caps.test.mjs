import assert from "node:assert/strict";
import test from "node:test";

import {
  MODEL_CATALOG,
  adapterDefaultCaps,
  findModelEntry,
  normalizeImageParams,
  normalizeVideoParams,
  resolveModelCaps,
} from "../dist/index.js";

test("目录条目：id 唯一且带能力", () => {
  const ids = MODEL_CATALOG.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of MODEL_CATALOG) {
    assert.ok(entry.label.length > 0);
    assert.ok(entry.caps.kind === entry.kind);
  }
});

test("图像参数规整：越界夹取", () => {
  const caps = findModelEntry("glm-image").caps;
  const result = normalizeImageParams(caps, { aspectRatio: "16:9", resolutionTier: "4k", n: 9 });
  assert.equal(result.resolutionTier, "2k");
  assert.equal(result.n, 4);
  assert.ok(result.notes.some((note) => note.includes("分辨率档")));
  assert.ok(result.notes.some((note) => note.includes("张数")));
});

test("视频参数规整：时长步进与边界", () => {
  const sora = findModelEntry("sora-2").caps;
  const clamped = normalizeVideoParams(sora, { durationSeconds: 12, aspectRatio: "4:3", resolution: "1080p" });
  // sora-2：步进 4（8/12/16/20 取 12），仅 720p，仅 16:9/9:16
  assert.equal(clamped.durationSeconds, 12);
  assert.equal(clamped.resolution, "720p");
  assert.equal(clamped.aspectRatio, "16:9");

  const wan = findModelEntry("wan2.7-t2v").caps;
  const bounded = normalizeVideoParams(wan, { durationSeconds: 99 });
  assert.equal(bounded.durationSeconds, 15);

  const flash = findModelEntry("wan2.6-i2v-flash").caps;
  const silent = normalizeVideoParams(flash, { durationSeconds: 5, withAudio: true });
  assert.equal(silent.withAudio, false);
  assert.ok(silent.notes.some((note) => note.includes("不支持音频")));
});

test("custom 模型：adapter 宽松默认能力", () => {
  const caps = resolveModelCaps("volcengine", "doubao-seedream-6-0", "image");
  assert.equal(caps.kind, "image");
  assert.equal(caps.maxRefImages, 10);
  const video = adapterDefaultCaps("openai", "video");
  assert.equal(video.minDurationSeconds, 8);
});
