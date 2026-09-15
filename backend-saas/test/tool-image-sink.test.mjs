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
