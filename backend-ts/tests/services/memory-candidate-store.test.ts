import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("memory candidate store", () => {
  it("keeps candidates private by owner and enforces lifecycle transitions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-memory-candidate-"));
    roots.push(root);
    const store = createConversationStore({ dbPath: path.join(root, "ragsystem.db"), dataRoot: root });
    const alice = store.createMemoryCandidate({
      tenantId: "tnt_alpha",
      ownerUserId: "usr_alice",
      targetScope: "team",
      teamName: "default",
      name: "Review rule",
      description: "review before publishing",
      memoryType: "constraint",
      content: "Always review shared changes.",
    });
    store.createMemoryCandidate({
      tenantId: "tnt_alpha",
      ownerUserId: "usr_bob",
      targetScope: "team",
      teamName: "default",
      name: "Bob rule",
      description: "private to bob",
      memoryType: "fact",
      content: "Bob content",
    });

    expect(store.listMemoryCandidates({ ownerUserId: "usr_alice", statuses: ["candidate"] }))
      .toEqual([expect.objectContaining({ id: alice.id, owner_user_id: "usr_alice" })]);
    expect(store.updateMemoryCandidate({ id: alice.id, ownerUserId: "usr_bob", content: "tampered" })).toBe(false);
    expect(store.reviewMemoryCandidate({ id: alice.id, status: "approved", reviewerUserId: "usr_admin" })).toBe(true);
    expect(store.updateMemoryCandidate({ id: alice.id, ownerUserId: "usr_alice", content: "late edit" })).toBe(false);
    expect(store.getMemoryCandidate(alice.id)).toMatchObject({ status: "approved", reviewer_user_id: "usr_admin" });
    store.close();
  });

  it("limits injected candidate queries and records the final published content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-memory-candidate-"));
    roots.push(root);
    const store = createConversationStore({ dbPath: path.join(root, "ragsystem.db"), dataRoot: root });
    const created = store.createMemoryCandidate({
      tenantId: "tnt_alpha", ownerUserId: "usr_alice", targetScope: "team", teamName: "default",
      name: "Draft", description: "draft", memoryType: "fact", content: "draft content",
    });
    for (let index = 0; index < 4; index += 1) {
      store.createMemoryCandidate({
        tenantId: "tnt_alpha", ownerUserId: "usr_alice", targetScope: "team", teamName: "default",
        name: `Extra ${index}`, description: "extra", memoryType: "fact", content: "extra",
      });
    }
    expect(store.listMemoryCandidates({ ownerUserId: "usr_alice", limit: 2 })).toHaveLength(2);
    expect(store.listMemoryCandidates({ ownerUserId: "usr_alice", limit: 2, offset: 2 })).toHaveLength(2);
    expect(store.countMemoryCandidates({ ownerUserId: "usr_alice" })).toBe(5);
    expect(store.reviewMemoryCandidate({
      id: created.id,
      status: "approved",
      reviewerUserId: "usr_admin",
      publishedName: "Published",
      publishedDescription: "published description",
      publishedContent: "published content",
    })).toBe(true);
    expect(store.getMemoryCandidate(created.id)).toMatchObject({
      name: "Published",
      description: "published description",
      content: "published content",
    });
    store.close();
  });

  it("reclaims stale review claims and blocks owner edits while claimed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-memory-candidate-"));
    roots.push(root);
    const store = createConversationStore({ dbPath: path.join(root, "ragsystem.db"), dataRoot: root });
    const candidate = store.createMemoryCandidate({
      tenantId: "tnt_alpha", ownerUserId: "usr_alice", targetScope: "team", teamName: "default",
      name: "Draft", description: "draft", memoryType: "fact", content: "draft",
    });
    const claim = store.claimMemoryCandidate(candidate.id, "usr_admin");
    expect(claim).toMatchObject({ attemptId: expect.any(String), claimedAt: expect.any(String) });
    expect(store.updateMemoryCandidate({ id: candidate.id, ownerUserId: "usr_alice", content: "tampered" })).toBe(false);
    expect(store.withdrawMemoryCandidate(candidate.id, "usr_alice")).toBe(false);
    expect(store.claimMemoryCandidate(candidate.id, "usr_other")).toBeNull();
    expect(store.releaseMemoryCandidate(candidate.id, "usr_admin", "wrong-attempt")).toBe(false);
    expect(store.releaseMemoryCandidate(candidate.id, "usr_admin", claim!.attemptId)).toBe(true);
    store.close();
  });
});
