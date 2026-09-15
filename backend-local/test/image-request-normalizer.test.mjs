import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

import sharp from "sharp";

import { DEFAULT_IMAGE_REQUEST_POLICY } from "@ragsystem/backend-core/contracts/images/image-request.js";
import { CoreImageRequestNormalizer } from "@ragsystem/backend-core/services/images/image-request-normalizer.js";
import { FileIndexService } from "../dist/adapters/local/files/file-index-service.js";
import { ImageRequestVariantStore } from "../dist/adapters/local/files/image-request-variants.js";
import { LocalSessionFileLookup } from "../dist/adapters/local/files/session-file-lookup.js";
import { LocalSessionFileApplication } from "../dist/adapters/local/application/session-file/local-session-file-application.js";

/* ── 测试夹具 ── */

/** 真随机噪声：不可压缩，保证有损编码不会退化为纯色/直通。 */
async function noiseImage(width, height, options = {}) {
  const bytes = randomBytes(width * height * 3);
  return sharp(bytes, { raw: { width, height, channels: 3 } }).png().toBuffer().then((data) =>
    options.lossless === false ? sharp(data).jpeg({ quality: 92 }).toBuffer() : data,
  );
}

const normalizer = new CoreImageRequestNormalizer();

/* ── 归一化核心 ── */

test("clean small srgb images pass through byte-identically", async () => {
  const source = await sharp({
    create: { width: 24, height: 16, channels: 3, background: "#3388cc" },
  }).png().toBuffer();
  const result = await normalizer.normalize({ data: source, mime: "image/png", policy: DEFAULT_IMAGE_REQUEST_POLICY });
  assert.equal(result.kind, "passthrough");
});

test("oversized images are downscaled inside the pixel and long-edge budgets", async () => {
  const source = await noiseImage(3000, 2200, { lossless: false });
  const policy = { maxPixels: 500_000, maxDimension: 600, maxBytes: 200_000 };
  const result = await normalizer.normalize({ data: source, mime: "image/jpeg", policy });
  assert.equal(result.kind, "normalized");
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.width * result.height <= policy.maxPixels, `pixels ${result.width}x${result.height}`);
  assert.ok(Math.max(result.width, result.height) <= policy.maxDimension, `long edge ${result.width}x${result.height}`);
  assert.ok(result.data.byteLength <= policy.maxBytes, `bytes ${result.data.byteLength}`);
  assert.equal(result.originalWidth, 3000);
  assert.equal(result.originalHeight, 2200);
  // 输出可再解码，且格式与声明的 mime 一致
  const meta = await sharp(result.data).metadata();
  assert.equal(meta.format, "jpeg");
});

test("alpha sources re-encode to webp and drop the alpha-incompatible jpeg path", async () => {
  const rgba = randomBytes(600 * 400 * 4);
  const source = await sharp(rgba, { raw: { width: 600, height: 400, channels: 4 } }).png().toBuffer();
  // 字节预算压到原 png 之下，强制走重编码
  const policy = { maxPixels: DEFAULT_IMAGE_REQUEST_POLICY.maxPixels, maxDimension: 2048, maxBytes: 10_000 };
  const result = await normalizer.normalize({ data: source, mime: "image/png", policy });
  assert.equal(result.kind, "normalized");
  assert.equal(result.mime, "image/webp");
  const meta = await sharp(result.data).metadata();
  assert.equal(meta.format, "webp");
});

test("exif orientation is applied so the model sees the perceived axes", async () => {
  const rgb = Buffer.alloc(400 * 300 * 3);
  for (let index = 0; index < rgb.length; index += 1) rgb[index] = (index * 13 + 11) % 256;
  const source = await sharp(rgb, { raw: { width: 400, height: 300, channels: 3 } })
    .jpeg({ quality: 92 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const policy = { maxPixels: 100_000, maxDimension: 200, maxBytes: 100_000 };
  const result = await normalizer.normalize({ data: source, mime: "image/jpeg", policy });
  assert.equal(result.kind, "normalized");
  // orientation 6 转置：感知为 300x400（竖图），归一化后仍是竖图
  assert.ok(result.height > result.width, `expected portrait, got ${result.width}x${result.height}`);
  const meta = await sharp(result.data).metadata();
  assert.equal(meta.orientation, undefined);
});

test("corrupt bytes report invalid and gifs pass through untouched", async () => {
  const corrupt = await normalizer.normalize({
    data: Buffer.from("not an image at all"),
    mime: "image/png",
    policy: DEFAULT_IMAGE_REQUEST_POLICY,
  });
  assert.equal(corrupt.kind, "invalid");

  const gif = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#123456" },
  }).gif().toBuffer();
  const result = await normalizer.normalize({ data: gif, mime: "image/gif", policy: DEFAULT_IMAGE_REQUEST_POLICY });
  assert.equal(result.kind, "passthrough");
});

/* ── 变体缓存 + 会话附件读取 ── */

test("session file lookup serves normalized variants with a stat-validated disk cache", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-image-variants-"));
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const variants = new ImageRequestVariantStore(files, normalizer);
  const lookup = new LocalSessionFileLookup(files, variants);
  const policy = { maxPixels: 500_000, maxDimension: 600, maxBytes: 200_000 };

  try {
    const source = await noiseImage(3000, 2200, { lossless: false });
    const record = files.add({
      originalName: "photo.jpg",
      buffer: source,
      mime: "image/jpeg",
      scopeType: "session",
      scopeId: "session-1",
    });

    const raw = await lookup.read("session-1", record.id);
    assert.equal(raw?.contentType, "image/jpeg");
    assert.equal(raw?.body.byteLength, source.byteLength);

    const variant = await lookup.read("session-1", record.id, { imageRequest: policy });
    assert.ok(variant, "expected a normalized variant");
    assert.ok(variant.body.byteLength < source.byteLength);
    assert.equal(variant.contentType, "image/jpeg");

    // 变体已落盘缓存，命中路径不再重新归一化（改策略 key 以外内容验证 meta 存在）
    const variantDir = path.join(files.getSessionUploadsRoot("session-1"), ".variants");
    const metaFiles = fs.readdirSync(variantDir).filter((name) => name.endsWith(".meta.json"));
    assert.equal(metaFiles.length, 1);
    const cached = await lookup.read("session-1", record.id, { imageRequest: policy });
    assert.equal(cached?.body.byteLength, variant.body.byteLength);

    // 源文件被改动（size/mtime 变化）→ 缓存失效，按新字节重新归一化
    const replacement = await noiseImage(1200, 900, { lossless: false });
    fs.writeFileSync(path.resolve(record.stored_path), replacement);
    const regenerated = await lookup.read("session-1", record.id, { imageRequest: policy });
    assert.ok(regenerated);
    const meta = await sharp(regenerated.body).metadata();
    assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= policy.maxDimension);

    // 非图片附件带 imageRequest 选项也只回原字节
    const textRecord = files.add({
      originalName: "note.txt",
      buffer: Buffer.from("hello"),
      mime: "text/plain",
      scopeType: "session",
      scopeId: "session-1",
    });
    const textRead = await lookup.read("session-1", textRecord.id, { imageRequest: policy });
    assert.equal(textRead?.contentType, "text/plain");
    assert.equal(Buffer.from(textRead?.body ?? []).toString("utf8"), "hello");
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("lookup without a variant store ignores image request options", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-image-variants-"));
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const lookup = new LocalSessionFileLookup(files);

  try {
    const source = await noiseImage(2000, 1500, { lossless: false });
    const record = files.add({
      originalName: "photo.jpg",
      buffer: source,
      mime: "image/jpeg",
      scopeType: "session",
      scopeId: "session-1",
    });
    const result = await lookup.read("session-1", record.id, {
      imageRequest: { maxPixels: 50_000, maxDimension: 100, maxBytes: 10_000 },
    });
    assert.equal(result?.body.byteLength, source.byteLength);
    assert.equal(result?.contentType, "image/jpeg");
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("variant cache entries fail closed when the generator version does not match", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-image-variants-"));
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const variants = new ImageRequestVariantStore(files, normalizer);
  const lookup = new LocalSessionFileLookup(files, variants);
  const policy = { maxPixels: 500_000, maxDimension: 600, maxBytes: 200_000 };

  try {
    const source = await noiseImage(3000, 2200, { lossless: false });
    const record = files.add({
      originalName: "photo.jpg",
      buffer: source,
      mime: "image/jpeg",
      scopeType: "session",
      scopeId: "session-1",
    });
    const first = await lookup.read("session-1", record.id, { imageRequest: policy });
    assert.ok(first);

    // 篡改 meta 的 generator（模拟旧代次缓存）：验效必须判未命中并重算
    const variantDir = path.join(files.getSessionUploadsRoot("session-1"), ".variants");
    const metaPath = path.join(variantDir, fs.readdirSync(variantDir).find((name) => name.endsWith(".meta.json")));
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.generator = "v0";
    fs.writeFileSync(metaPath, `${JSON.stringify(meta)}\n`);

    const second = await lookup.read("session-1", record.id, { imageRequest: policy });
    assert.ok(second);
    assert.equal(second.contentType, "image/jpeg");
    const regeneratedMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.notEqual(regeneratedMeta.generator, "v0");
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("pathologically large pixel counts are rejected before decoding", async () => {
  // 纯色 12000×9000（1.08 亿像素）PNG 编码后约 1.4MB，解码会展开约 300MB——
  // 必须在探测阶段拒绝，不做全量解码。
  const source = await sharp({
    create: { width: 12000, height: 9000, channels: 3, background: "#3388cc" },
  }).png().toBuffer();
  assert.ok(source.byteLength < 2 * 1024 * 1024, "fixture should stay far below its decoded size");
  const result = await normalizer.normalize({ data: source, mime: "image/png", policy: DEFAULT_IMAGE_REQUEST_POLICY });
  assert.equal(result.kind, "invalid");
});

test("quality ladder exhaustion keeps the smallest output as normalized", async () => {
  // 像素/长边均在预算内、但字节预算压到任何质量档都达不到：保底取最小档（q60）
  const source = await noiseImage(300, 200, { lossless: false });
  const policy = { maxPixels: 1_000_000, maxDimension: 2048, maxBytes: 100 };
  const result = await normalizer.normalize({ data: source, mime: "image/jpeg", policy });
  assert.equal(result.kind, "normalized");
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.data.byteLength > policy.maxBytes, "ladder should be exhausted");
  const meta = await sharp(result.data).metadata();
  assert.equal(meta.format, "jpeg");
  assert.equal(meta.width, 300);
  // 保底输出不大于手工 q60 编码（同管线无缩放/旋转时逐字节一致）
  const manual = await sharp(source).jpeg({ quality: 60 }).toBuffer();
  assert.ok(result.data.byteLength <= manual.byteLength + 1024);
});

test("variant store dedupes concurrent reads and never re-probes negative cache hits", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-image-variants-"));
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  let calls = 0;
  const countingStore = new ImageRequestVariantStore(files, {
    normalize: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { kind: "passthrough" };
    },
  });
  const lookup = new LocalSessionFileLookup(files, countingStore);
  const policy = { maxPixels: 500_000, maxDimension: 600, maxBytes: 200_000 };

  try {
    const record = files.add({
      originalName: "photo.png",
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
      mime: "image/png",
      scopeType: "session",
      scopeId: "session-1",
    });
    // 并发两读：in-flight 去重，normalize 只执行一次
    const [a, b] = await Promise.all([
      lookup.read("session-1", record.id, { imageRequest: policy }),
      lookup.read("session-1", record.id, { imageRequest: policy }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual([a?.contentType, b?.contentType], ["image/png", "image/png"]);
    // 第三次读：负缓存命中，不再探测
    await lookup.read("session-1", record.id, { imageRequest: policy });
    assert.equal(calls, 1);
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("deleting a session file removes its cached variants and negative entries", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-image-variants-"));
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const variants = new ImageRequestVariantStore(files, normalizer);
  const lookup = new LocalSessionFileLookup(files, variants);
  const application = new LocalSessionFileApplication(files);
  const policy = { maxPixels: 500_000, maxDimension: 600, maxBytes: 200_000 };

  try {
    const source = await noiseImage(3000, 2200, { lossless: false });
    const record = files.add({
      originalName: "photo.jpg",
      buffer: source,
      mime: "image/jpeg",
      scopeType: "session",
      scopeId: "session-1",
    });
    const sibling = files.add({
      originalName: "other.jpg",
      buffer: await noiseImage(2000, 1600, { lossless: false }),
      mime: "image/jpeg",
      scopeType: "session",
      scopeId: "session-1",
    });
    await lookup.read("session-1", record.id, { imageRequest: policy });
    await lookup.read("session-1", sibling.id, { imageRequest: policy });
    const variantDir = path.join(files.getSessionUploadsRoot("session-1"), ".variants");
    assert.ok(fs.readdirSync(variantDir).some((name) => name.startsWith(record.id)));

    await application.delete("session-1", record.id);
    const remaining = fs.existsSync(variantDir)
      ? fs.readdirSync(variantDir).filter((name) => name.startsWith(record.id))
      : [];
    assert.equal(remaining.length, 0);
    // 前缀清理不得误伤同会话其他附件的变体
    assert.ok(fs.readdirSync(variantDir).some((name) => name.startsWith(sibling.id)));
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("stale crash-leftover tmp files are swept on the next cache miss", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-image-variants-"));
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const variants = new ImageRequestVariantStore(files, normalizer);
  const lookup = new LocalSessionFileLookup(files, variants);
  const policy = { maxPixels: 500_000, maxDimension: 600, maxBytes: 200_000 };

  try {
    const source = await noiseImage(3000, 2200, { lossless: false });
    const record = files.add({
      originalName: "photo.jpg",
      buffer: source,
      mime: "image/jpeg",
      scopeType: "session",
      scopeId: "session-1",
    });
    const variantDir = path.join(files.getSessionUploadsRoot("session-1"), ".variants");
    fs.mkdirSync(variantDir, { recursive: true });
    const stale = path.join(variantDir, "deadbeef-old.uuid.tmp");
    fs.writeFileSync(stale, "leftover");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    await lookup.read("session-1", record.id, { imageRequest: policy }); // miss → sweep
    assert.equal(fs.existsSync(stale), false);
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
