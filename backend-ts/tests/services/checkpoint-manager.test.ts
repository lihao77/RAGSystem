import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CheckpointManager } from "../../src/services/stores/checkpoint-manager.js";

describe("CheckpointManager", () => {
  it("saves, loads, filters, and deletes checkpoints like Python", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-checkpoints-"));
    const manager = new CheckpointManager({ dbPath: path.join(root, "checkpoints.db") });
    try {
      const first = manager.saveCheckpoint({
        sessionId: "s1",
        agentName: "qa_agent",
        round: 1,
        messages: [{ role: "user", content: "q1", metadata: {}, seq: 1 }],
        metadata: { source: "test" },
      });
      const second = manager.saveCheckpoint({
        sessionId: "s1",
        agentName: "qa_agent",
        round: 2,
        messages: [{ role: "user", content: "q2", metadata: {}, seq: 2 }],
      });
      manager.saveCheckpoint({
        sessionId: "s1",
        agentName: "other_agent",
        round: 3,
        messages: [{ role: "user", content: "other" }],
      });

      expect(first).toBe("s1_qa_agent_r1");
      expect(second).toBe("s1_qa_agent_r2");
      expect(manager.loadCheckpoint(first)).toMatchObject({
        checkpoint_id: first,
        session_id: "s1",
        agent_name: "qa_agent",
        round: 1,
        metadata: { source: "test" },
        messages: [{ role: "user", content: "q1", seq: 1 }],
      });
      expect(manager.getLatestCheckpoint("s1", "qa_agent")).toMatchObject({
        checkpoint_id: second,
        round: 2,
      });
      expect(manager.listCheckpoints({ sessionId: "s1", agentName: "qa_agent" }).map((item) => item.round)).toEqual([
        2,
        1,
      ]);
      expect(manager.deleteCheckpoint(first)).toBe(true);
      expect(manager.deleteSessionCheckpoints("s1")).toBe(2);
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
