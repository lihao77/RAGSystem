import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SkillAuthoringService } from "../dist/services/skill-authoring-service.js";
import { FilesystemSkillPackageStore } from "../dist/storage/local/package-store.js";

test("Skill Artifact submission copies the complete bundle and is idempotent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-artifact-import-"));
  try {
    const files = [
      ["SKILL.md", Buffer.from("---\nname: bundle-skill\ndescription: Bundle skill\nmetadata:\n  ragsystem_requires_tools: \"preview_data_structure\"\n---\nDo the work.\n"), "text/markdown; charset=utf-8"],
      ["scripts/check.py", Buffer.from("print('ok')\n"), "text/x-python; charset=utf-8"],
      ["resources/schema.json", Buffer.from("{\"ok\":true}\n"), "application/json"],
    ];
    const assets = files.map(([filename, body, media_type], index) => ({
      asset_id: `asset-${index}`,
      role: "file",
      filename: path.basename(filename),
      media_type,
      size: body.length,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    }));
    const application = {
      async getArtifact() {
        return {
          schema_version: 2,
          artifact_id: "art_skill_1",
          revision: 1,
          session_id: "session-1",
          kind: "skill",
          subtype: "bundle",
          title: "Bundle Skill",
          status: "ready",
          assets,
          presentations: [],
          metadata: {
            skill_bundle_paths: Object.fromEntries(files.map(([filename], index) => [`asset-${index}`, filename])),
          },
          provenance: {},
          relations: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      },
      async getArtifactAsset(_id, assetId) {
        const index = assets.findIndex((item) => item.asset_id === assetId);
        const asset = assets[index];
        const body = files[index][1];
        return { body, mediaType: asset.media_type, filename: asset.filename, sha256: asset.sha256 };
      },
    };
    const rows = new Map();
    const store = {
      async list() { return [...rows.values()]; },
      async get(id) { return rows.get(id) ?? null; },
      async create(value) { rows.set(value.id, value); },
      async update(expected, value) {
        const current = rows.get(value.id);
        if (!current || current.revision !== expected) return false;
        rows.set(value.id, value);
        return true;
      },
      async delete(id, expected) {
        const current = rows.get(id);
        if (!current || current.revision !== expected) return false;
        rows.delete(id);
        return true;
      },
    };
    const packageStore = new FilesystemSkillPackageStore(path.join(root, "skills"));
    const library = {
      async listSkills() {
        return (await packageStore.list()).map((skill) => ({ name: skill.name, source_type: "user_global" }));
      },
      async getSkillDetail(name) {
        const skill = await packageStore.get(name);
        return { source_type: "user_global", description: skill.description, content: skill.content };
      },
      async createSkillBundle(input) {
        return packageStore.createBundle(input);
      },
      async matchesSkillBundle(name, bundle) {
        const files = await packageStore.listFiles(name);
        const expected = new Map(bundle.map((file) => [file.relativePath, Buffer.from(file.body)]));
        const actual = files.filter((file) => file.type === "file");
        if (actual.length !== expected.size || actual.some((file) => !expected.has(file.path))) return false;
        for (const file of actual) {
          const stored = await packageStore.readFile(name, file.path);
          if (!stored || !Buffer.from(stored.body).equals(expected.get(file.path))) return false;
        }
        return true;
      },
    };
    const service = new SkillAuthoringService(store, library, application);
    const candidate = await service.submitArtifact("art_skill_1", 1, { sourceSessionId: "session-1" });
    assert.equal(candidate.bundle_assets.length, 3);
    assert.equal((await service.submitArtifact("art_skill_1", 1, { sourceSessionId: "session-1" })).id, candidate.id);
    application.getArtifact = async () => { throw new Error("source Artifact deleted"); };
    const published = await service.publishDraft(candidate.id, candidate.revision);
    assert.equal(published.status, "published");
    assert.equal(fs.existsSync(path.join(root, "skills", "bundle-skill", "scripts", "check.py")), true);
    assert.equal(fs.readFileSync(path.join(root, "skills", "bundle-skill", "resources", "schema.json"), "utf8").trim(), "{\"ok\":true}");
    assert.match(fs.readFileSync(path.join(root, "skills", "bundle-skill", "SKILL.md"), "utf8"), /ragsystem_requires_tools/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
