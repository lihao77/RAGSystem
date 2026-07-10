import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TransientArtifactService } from "../../src/services/artifacts/transient-artifact-service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-transient-"));
  roots.push(root);
  return root;
}

describe("TransientArtifactService", () => {
  it("skips sessions that have no transient directory", async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "sessions", "plain-session"), { recursive: true });
    await expect(new TransientArtifactService(root).pruneExpired()).resolves.toEqual({ deleted: 0, retained: 0 });
  });

  it("deletes only expired managed files and preserves unsafe or malformed index entries", async () => {
    const root = makeRoot();
    const transient = path.join(root, "sessions", "s1", "transient");
    fs.mkdirSync(transient, { recursive: true });
    const expired = path.join(transient, "expired.txt");
    const current = path.join(transient, "current.txt");
    const outside = path.join(root, "outside.txt");
    for (const file of [expired, current, outside]) fs.writeFileSync(file, "x");
    fs.writeFileSync(path.join(transient, "artifact_index.jsonl"), [
      JSON.stringify({ path: expired, expires_at: 10 }),
      JSON.stringify({ path: current, expires_at: 30 }),
      JSON.stringify({ path: outside, expires_at: 10 }),
      "not-json",
      "",
    ].join("\n"));

    const result = await new TransientArtifactService(root).pruneExpired(20);

    expect(result).toEqual({ deleted: 1, retained: 3 });
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readFileSync(path.join(transient, "artifact_index.jsonl"), "utf8")).toContain("not-json");
  });

  it("removes the managed session directory on session deletion", () => {
    const root = makeRoot();
    const sessionRoot = path.join(root, "sessions", "s1");
    fs.mkdirSync(path.join(sessionRoot, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, "workspace", "result.txt"), "x");

    new TransientArtifactService(root).deleteSessionArtifacts("s1");

    expect(fs.existsSync(sessionRoot)).toBe(false);
  });

  it("removes old managed orphan files even when the index is missing", async () => {
    const root = makeRoot();
    const transient = path.join(root, "sessions", "s1", "transient");
    fs.mkdirSync(transient, { recursive: true });
    const orphan = path.join(transient, "image_deadbeef.png");
    fs.writeFileSync(orphan, "orphan");
    fs.utimesSync(orphan, new Date(0), new Date(0));

    const result = await new TransientArtifactService(root).pruneExpired(25 * 60 * 60);

    expect(result.deleted).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("rewrites retained indexes atomically without leaving temp files", async () => {
    const root = makeRoot();
    const transient = path.join(root, "sessions", "s1", "transient");
    fs.mkdirSync(transient, { recursive: true });
    const current = path.join(transient, "data_deadbeef.txt");
    fs.writeFileSync(current, "current");
    fs.writeFileSync(path.join(transient, "artifact_index.jsonl"), `${JSON.stringify({ path: current, expires_at: 30 })}\n`);

    await new TransientArtifactService(root).pruneExpired(20);

    expect(fs.readdirSync(transient).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fs.readFileSync(path.join(transient, "artifact_index.jsonl"), "utf8")).toContain("data_deadbeef.txt");
  });
});
