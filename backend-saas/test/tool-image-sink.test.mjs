import assert from "node:assert/strict";
import test from "node:test";

import { SaaSToolImageSink } from "../dist/adapters/saas/composition/tool-image-sink.js";

/** 内存版 AsyncSessionFileStorage 桩：验证 SaaS sink 的进程内内容去重。 */
function memoryStorage() {
  let seq = 0;
  const sessions = new Map();
  return {
    async list(sessionId) {
      return [...(sessions.get(sessionId) ?? new Map()).values()];
    },
    async get(sessionId, fileId) {
      return sessions.get(sessionId)?.get(fileId) ?? null;
    },
    async add(sessionId, { originalName, buffer, mime }) {
      const id = `f${++seq}`;
      const record = {
        id,
        original_name: originalName,
        stored_name: `${id}_${originalName}`,
        stored_path: `tenants/t1/sessions/${sessionId}/attachments/${id}`,
        size: buffer.byteLength,
        mime,
        uploaded_at: new Date().toISOString(),
        uploaded_by: null,
        indexed_in_vector: false,
        tags: null,
        notes: null,
        scope_type: "session",
        scope_id: sessionId,
        storage_kind: "managed",
      };
      if (!sessions.has(sessionId)) sessions.set(sessionId, new Map());
      sessions.get(sessionId).set(id, record);
      return record;
    },
    async delete(sessionId, fileId) {
      const record = sessions.get(sessionId)?.get(fileId) ?? null;
      sessions.get(sessionId)?.delete(fileId);
      return record;
    },
    async read() {
      return null;
    },
  };
}

test("saas tool image sink dedupes identical bytes in-process and re-persists after deletion", async () => {
  const storage = memoryStorage();
  const sink = new SaaSToolImageSink(storage);
  const bytes = new Uint8Array([1, 2, 3, 4]);

  const first = await sink.save({ bytes, mimeType: "image/png", toolName: "view_image", sessionId: "s1", name: "a.png" });
  const second = await sink.save({ bytes, mimeType: "image/png", toolName: "view_image", sessionId: "s1", name: "a.png" });
  assert.equal(second.fileId, first.fileId);
  assert.equal((await storage.list("s1")).length, 1);

  const [a, b] = await Promise.all([
    sink.save({ bytes, mimeType: "image/png", toolName: "t", sessionId: "s1" }),
    sink.save({ bytes, mimeType: "image/png", toolName: "t", sessionId: "s1" }),
  ]);
  assert.equal(a.fileId, first.fileId);
  assert.equal(b.fileId, first.fileId);

  // 跨会话隔离
  const cross = await sink.save({ bytes, mimeType: "image/png", toolName: "t", sessionId: "s2" });
  assert.notEqual(cross.fileId, first.fileId);

  // 删除后重建
  await storage.delete("s1", first.fileId);
  const revived = await sink.save({ bytes, mimeType: "image/png", toolName: "t", sessionId: "s1" });
  assert.notEqual(revived.fileId, first.fileId);
});

test("saas tool image sink aligns the display name extension with the actual encoding", async () => {
  const storage = memoryStorage();
  const sink = new SaaSToolImageSink(storage);

  // 换码产物（如超限缩放后的 view_image JPEG）带 .png 名：展示名对齐到 .jpg，
  // 附件记录 name/mime/字节保持自洽——前端按扩展名与 mime 一致才认图片。
  // 各场景用不同字节：sink 按字节哈希去重，同字节会命中同一条记录。
  const persisted = await sink.save({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "image/jpeg", toolName: "view_image", sessionId: "s1", name: "photo.png" });
  const record = await storage.get("s1", persisted.fileId);
  assert.equal(record.original_name, "photo.jpg");
  assert.equal(record.mime, "image/jpeg");

  // 扩展名与 mime 一致时原样保留；未知/不匹配扩展名同样对齐到 mime
  const kept = await sink.save({ bytes: new Uint8Array([5, 6, 7, 8]), mimeType: "image/png", toolName: "t", sessionId: "s1", name: "icon.png" });
  assert.equal((await storage.get("s1", kept.fileId)).original_name, "icon.png");
  const unknown = await sink.save({ bytes: new Uint8Array([9, 10, 11, 12]), mimeType: "image/webp", toolName: "mcp", sessionId: "s1", name: "chart.bin" });
  assert.equal((await storage.get("s1", unknown.fileId)).original_name, "chart.webp");
});
