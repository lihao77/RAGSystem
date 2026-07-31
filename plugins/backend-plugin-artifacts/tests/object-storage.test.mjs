import assert from "node:assert/strict";
import test from "node:test";

import { ObjectArtifactApplication } from "../dist/storage/postgres/object-artifact-application.js";

test("Object Artifact V2 owns multi-asset lifecycle", async () => {
  const rows = new Map();
  const objects = new Map();
  const metadata = {
    async get(tenantId, artifactId) { return rows.get(`${tenantId}/${artifactId}`) ?? null; },
    async list(tenantId, sessionId) {
      return [...rows.values()].filter((row) => row.tenant_id === tenantId && (sessionId == null || row.session_id === sessionId));
    },
    async create(input) {
      const row = { ...input, created_at: input.created_at, updated_at: input.updated_at };
      rows.set(`${input.tenant_id}/${input.artifact_id}`, row);
      return row;
    },
    async updateRevision(input) {
      const key = `${input.tenantId}/${input.artifactId}`;
      const current = rows.get(key);
      if (!current) return null;
      const updated = { ...current, revision: input.revision, title: input.title, status: input.status, presentation_count: input.presentationCount, updated_at: new Date().toISOString() };
      rows.set(key, updated);
      return updated;
    },
    async delete(tenantId, artifactId) { return rows.delete(`${tenantId}/${artifactId}`); },
  };
  const objectStorage = {
    async put(key, body) { objects.set(key, Buffer.from(body)); },
    async get(key) { const body = objects.get(key); return body ? { body } : null; },
    async delete(key) { return objects.delete(key); },
  };
  const application = new ObjectArtifactApplication("tenant-a", metadata, objectStorage);

  const created = await application.createArtifact({
    sessionId: "session-a",
    kind: "map.raster",
    assets: [
      { assetId: "data", role: "data", source: { type: "memory", body: Buffer.from([1, 2]) }, mediaType: "image/tiff", filename: "data.tif" },
      { assetId: "preview", role: "preview", source: { type: "memory", body: Buffer.from([3, 4]) }, mediaType: "image/png", filename: "preview.png" },
    ],
    presentations: [{ presentation_id: "map", surface: "map", renderer: "map.raster-tile", assets: { source: "data" }, config: {} }],
  });

  assert.equal(created.asset_count, 2);
  assert.equal(objects.size, 3);
  assert.deepEqual((await application.getArtifactAsset(created.artifact_id, "data")).body, Buffer.from([1, 2]));
  const revised = await application.reviseArtifact({ artifactId: created.artifact_id, title: "Updated" });
  assert.equal(revised.revision, 2);
  assert.equal((await application.getArtifact(created.artifact_id)).title, "Updated");
  assert.equal(await application.deleteArtifact(created.artifact_id), true);
  assert.equal(objects.size, 0);
  assert.equal(rows.size, 0);
});
