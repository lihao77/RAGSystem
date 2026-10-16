import assert from "node:assert/strict";
import test from "node:test";
import { decodeSkillFiles, validateSkillBundle } from "../dist/contracts/skills/skill-bundle.js";

test("50MiB bundles decode without overflowing the regexp stack and retain the exact size boundary", () => {
  const markdown = Buffer.from("---\nname: large-skill\ndescription: Large bundle\n---\n\nRun scripts.");
  const resource = Buffer.alloc(50 * 1024 * 1024 - markdown.length);
  const decoded = decodeSkillFiles([
    { relative_path: "SKILL.md", body_base64: markdown.toString("base64") },
    { relative_path: "assets/data.bin", body_base64: resource.toString("base64") },
  ]);
  assert.doesNotThrow(() => validateSkillBundle("large-skill", decoded));
  assert.equal(decoded[1].body.byteLength, resource.length);
  assert.throws(() => validateSkillBundle("large-skill", [...decoded,
    { relativePath: "extra.bin", body: Buffer.from([1]) },
  ]), /50MB/);
});

test("bundle Base64 validation accepts padding and empty files but rejects malformed encodings", () => {
  for (const value of ["", "YQ==", "YWI=", "YWJj"]) {
    assert.equal(decodeSkillFiles([{ relative_path: "data.bin", body_base64: value }])[0].body.length,
      Buffer.byteLength(value, "base64"));
  }
  for (const value of ["A", "A===", "====", "AA=A", "YQ==\n", "YQ!!", "海洋"]) {
    assert.throws(() => decodeSkillFiles([{ relative_path: "data.bin", body_base64: value }]), /Invalid base64/);
  }
});
