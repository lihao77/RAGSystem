import assert from "node:assert/strict";
import test from "node:test";

import { estimateRequestTokenUsage, estimateTokens } from "../dist/compression/token-estimate.js";

test("估算细分：system 消息、tools schema 与 mcp/技能工具分开计数", () => {
  const usage = estimateRequestTokenUsage({
    messages: [
      { role: "system", content: "你是助手，遵守安全约束" },
      { role: "user", content: "你好" },
    ],
    tools: [
      { type: "function", function: { name: "builtin", description: "内置工具", parameters: {} }, source: "runtime_builtin" },
      { type: "function", function: { name: "mcp_search", description: "MCP 搜索工具", parameters: {} }, source: "mcp" },
      { type: "function", function: { name: "skill_run", description: "技能执行工具", parameters: {} }, source: "knowledge" },
    ],
  });

  assert.ok(usage.toolSchemaTokens > 0, "tools schema 应计入");
  assert.ok(usage.mcpToolTokens > 0, "mcp 来源工具应单独计数");
  assert.ok(usage.knowledgeToolTokens > 0, "knowledge(技能)来源工具应单独计数");
  // 工具 schema 已并入 systemPromptTokens（预算语义不变），system 文本部分仍为正。
  assert.ok(usage.systemPromptTokens - usage.toolSchemaTokens > 0, "system 消息文本独立于工具 schema");
  assert.equal(usage.totalTokens, usage.systemPromptTokens + usage.historyTokens);
});

test("无工具时不产生工具细分字段值（均为 0）", () => {
  const usage = estimateRequestTokenUsage({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(usage.toolSchemaTokens, 0);
  assert.equal(usage.mcpToolTokens, 0);
  assert.equal(usage.knowledgeToolTokens, 0);
  assert.equal(usage.totalTokens, usage.systemPromptTokens + usage.historyTokens);
});

/* ── 图片 token 估算:分辨率制,不再按 base64/4 ── */

function pngHeader(width, height) {
  // PNG 签名 + IHDR 块头(长度+类型) + 宽高 big-endian;解析只读前 24 字节,后续补零即可
  const buf = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegHeader(width, height) {
  // SOI + SOF0:长度(4-5) + precision(6) + 高(7-8) + 宽(9-10) big-endian
  const buf = Buffer.alloc(32);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff; buf[3] = 0xc0;
  buf.writeUInt16BE(17, 4);
  buf[6] = 8;
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

function gifHeader(width, height) {
  const buf = Buffer.alloc(32);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function webpVp8lHeader(width, height) {
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(16, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8L", 12, "ascii");
  buf.writeUInt32LE(8, 16);
  buf[20] = 0x2f;
  buf.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return buf;
}

function webpVp8Header(width, height) {
  // lossy keyframe:3B frame tag + 0x9d012a 同步码 + 14bit LE 宽高(各带 2bit scale 位)
  const buf = Buffer.alloc(40);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(20, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8 ", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a;
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

function webpVp8xHeader(width, height) {
  const buf = Buffer.alloc(32);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(16, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(10, 16);
  const w = width - 1, h = height - 1;
  buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff;
  return buf;
}

function progressiveJpegHeader(width, height, app1Lengths = [8 * 1024]) {
  // 链式 APP1(EXIF) 段 + SOF2(progressive):段长含长度字段自身 2 字节(UInt16 上限 65535,
  // 超窗场景用多段链),下一 marker 位于 marker 偏移 + 2 + length
  const total = app1Lengths.reduce((sum, len) => sum + 2 + len, 0);
  const buf = Buffer.alloc(2 + total + 32);
  buf[0] = 0xff; buf[1] = 0xd8; // SOI
  let offset = 2;
  for (const len of app1Lengths) {
    buf[offset] = 0xff; buf[offset + 1] = 0xe1;
    buf.writeUInt16BE(len, offset + 2);
    offset += 2 + len;
  }
  buf[offset] = 0xff; buf[offset + 1] = 0xc2;
  buf.writeUInt16BE(17, offset + 2);
  buf[offset + 4] = 8;
  buf.writeUInt16BE(height, offset + 5);
  buf.writeUInt16BE(width, offset + 7);
  return buf;
}

function imageUrl(buffer, mime = "image/png") {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

test("1080p PNG 截图按分辨率估:长边缩到 1568 后 (w*h)/750,不再按 base64/4", () => {
  // 旧口径:34 万字节数据(base64 45 万字符)会估出 11 万+ token
  const padded = Buffer.concat([pngHeader(1920, 1080), Buffer.alloc(343536 - 64)]);
  const tokens = estimateTokens([{ type: "image_url", image_url: { url: imageUrl(padded) } }]);
  // 1920×1080 → 1568×882 → 1,382,976/750 = 1843
  assert.equal(tokens, 1843);
  assert.ok(tokens < 4096, "钳制上限内");
});

test("四种格式宽高解析一致收敛到同一口径", () => {
  const expected = Math.floor((1568 * 882) / 750);
  for (const header of [pngHeader(1920, 1080), jpegHeader(1920, 1080), gifHeader(1920, 1080), webpVp8lHeader(1920, 1080)]) {
    assert.equal(
      estimateTokens([{ type: "image_url", image_url: { url: imageUrl(header) } }]),
      expected,
    );
  }
});

test("小图钳到下限 85;超大图长边缩放封顶 floor(1568²/750)=3278,与字节体积无关", () => {
  assert.equal(estimateTokens([{ type: "image_url", image_url: { url: imageUrl(pngHeader(100, 100)) } }]), 85);
  // 5000×5000 与 10000×10000 缩放后同为 1568×1568,验证不随字节体积变化
  const huge = estimateTokens([{ type: "image_url", image_url: { url: imageUrl(pngHeader(10000, 10000)) } }]);
  assert.equal(huge, Math.floor((1568 * 1568) / 750));
  assert.equal(huge, 3278);
});

test("WebP 三种封装(VP8X/VP8L/VP8 lossy)均解析宽高,极值 canvas 同样缩放封顶", () => {
  const expected = Math.floor((1568 * 882) / 750);
  assert.equal(estimateTokens([{ type: "image_url", image_url: { url: imageUrl(webpVp8Header(1920, 1080), "image/webp") } }]), expected);
  // VP8X 上限 16384×16384(24bit+1 封装)
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url: imageUrl(webpVp8xHeader(16384, 16384), "image/webp") } }]),
    3278,
  );
});

test("progressive JPEG(SOF2):marker 扫描跳过 APP1/EXIF 段后读到尺寸;SOF 超出 64KB 扫描窗回落", () => {
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url: imageUrl(progressiveJpegHeader(1920, 1080), "image/jpeg") } }]),
    Math.floor((1568 * 882) / 750),
  );
  // 两段 40KB APP1 链:SOF 落在 ~80KB 处,超出 64KB 解码窗口
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url: imageUrl(progressiveJpegHeader(1920, 1080, [40 * 1024, 40 * 1024]), "image/jpeg") } }]),
    1600,
  );
});

test("非 data-URL 形态:裸 base64 可解析,http URL 回落固定值", () => {
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url: pngHeader(1920, 1080).toString("base64") } }]),
    Math.floor((1568 * 882) / 750),
  );
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url: "https://example.com/shots/A_spawn.png?w=1920,h=1080" } }]),
    1600,
  );
});

test("缓存一致性:同 URL 重复调用同值,detail 不同不串值", () => {
  const url = imageUrl(pngHeader(1920, 1080));
  const first = estimateTokens([{ type: "image_url", image_url: { url } }]);
  const second = estimateTokens([{ type: "image_url", image_url: { url } }]);
  assert.equal(first, second);
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url, detail: "low" } }]),
    196,
  );
  assert.notEqual(first, 196);
});

test("detail:low 按 512 长边缩放计价", () => {
  // 1920×1080 low → 512×288 → 147456/750 = 196
  assert.equal(
    estimateTokens([{ type: "image_url", image_url: { url: imageUrl(pngHeader(1920, 1080)), detail: "low" } }]),
    196,
  );
});

test("尺寸不可读时回落固定值,估算与 base64 长度无关", () => {
  const garbage = Buffer.from("not-an-image-at-all-just-random-bytes".repeat(1000));
  const tokens = estimateTokens([{ type: "image_url", image_url: { url: imageUrl(garbage) } }]);
  assert.equal(tokens, 1600);
});

test("混合消息:图片按张计,文本按字符计,互不放大", () => {
  const tokens = estimateTokens([
    { type: "text", text: "看这张图" },
    { type: "image_url", image_url: { url: imageUrl(pngHeader(1920, 1080)) } },
  ]);
  assert.equal(tokens, 4 + 1843);
});
