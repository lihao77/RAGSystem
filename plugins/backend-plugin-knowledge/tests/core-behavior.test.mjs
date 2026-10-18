import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DocumentExtractDispatcher } from "../dist/services/knowledge/document-extract/dispatcher.js";
import { createEmbedder, HashFallbackEmbedder, RemoteEmbedder } from "../dist/services/integrations/embedder-registry.js";
import {
  keywordOverlapScore,
  reciprocalRankFusionScore,
  tokenize,
} from "../dist/services/vector-store/scoring.js";

const extractionConfig = {
  engine: "builtin",
  cli: { command: "", timeout: 120, applies_to: [] },
  http: { endpoint: "", timeout: 120, applies_to: [] },
};

test("Knowledge scoring supports mixed Chinese and Latin queries", () => {
  const tokens = tokenize("广西 flood-risk");
  assert.equal(tokens.includes("广西"), true);
  assert.equal(tokens.includes("flood-risk"), true);
  assert.equal(keywordOverlapScore("广西 洪水", "广西发生洪水预警"), 1);
  assert.equal(keywordOverlapScore("unrelated", "广西发生洪水预警"), 0);
});

test("embedder 工厂：自管 provider → RemoteEmbedder；无 provider → Hash 降级", () => {
  const provider = { provider_key: "bce", kind: "embedding", name: "BCE", api_endpoint: "https://bce.example.com", api_key: "k", model_name: "bce-embed", is_active: true };
  const remote = createEmbedder(provider, "bce-embed", { embed: async () => [] });
  assert.ok(remote instanceof RemoteEmbedder);
  assert.equal(remote.key, "remote:bce/bce-embed");
  assert.ok(createEmbedder(null, "any") instanceof HashFallbackEmbedder);
});

test("normalized reciprocal-rank fusion stays bounded and rewards both sources", () => {
  const both = reciprocalRankFusionScore({ vectorRank: 1, keywordRank: 1, activeSources: 2 });
  const vectorOnly = reciprocalRankFusionScore({ vectorRank: 1, keywordRank: null, activeSources: 2 });
  assert.equal(both, 1);
  assert.equal(vectorOnly < both, true);
  assert.equal(vectorOnly >= 0 && vectorOnly <= 1, true);
});

test("builtin Knowledge extraction preserves Markdown and converts HTML", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-extract-"));
  try {
    const markdownPath = path.join(root, "sample.md");
    const htmlPath = path.join(root, "sample.html");
    fs.writeFileSync(markdownPath, "# Heading\n\n- item", "utf8");
    fs.writeFileSync(htmlPath, "<h1>Heading</h1><ul><li>item</li></ul>", "utf8");
    const dispatcher = new DocumentExtractDispatcher(extractionConfig);

    assert.equal((await dispatcher.extract({ file_path: markdownPath, file_name: "sample.md" })).markdown, "# Heading\n\n- item");
    assert.match((await dispatcher.extract({ file_path: htmlPath, file_name: "sample.html" })).markdown, /# Heading/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builtin Knowledge extraction rejects unknown binary formats", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-binary-"));
  try {
    const target = path.join(root, "unknown.bin");
    fs.writeFileSync(target, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]));
    const dispatcher = new DocumentExtractDispatcher(extractionConfig);
    await assert.rejects(
      dispatcher.extract({ file_path: target, file_name: "unknown.bin", mime: "application/octet-stream" }),
      (error) => error?.statusCode === 415,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
