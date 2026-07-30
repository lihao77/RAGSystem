import { describe, expect, it } from "vitest";

import { parseRunAgentInput } from "../src/services/agui-gateway/agui-input.js";

describe("parseRunAgentInput attachments", () => {
  it("accepts strict file-id references", () => {
    expect(parseRunAgentInput({
      threadId: "session-1",
      runId: "run-1",
      attachments: [{ file_id: "file-nc" }],
    }).attachments).toEqual([{ file_id: "file-nc" }]);
  });

  it("rejects client-supplied attachment paths", () => {
    expect(() => parseRunAgentInput({
      threadId: "session-1",
      runId: "run-1",
      attachments: [{ file_id: "file-nc", file_path: "D:\\untrusted.nc" }],
    })).toThrow();
  });
});

describe("parseRunAgentInput reconnect", () => {
  it("accepts an active run cursor and rejects invalid cursors", () => {
    expect(parseRunAgentInput({
      threadId: "session-1",
      reconnect: { runId: "active-run-1", afterSeq: 42 },
    }).reconnect).toEqual({ runId: "active-run-1", afterSeq: 42 });

    expect(parseRunAgentInput({ reconnect: { runId: "active-run-1", afterSeq: -1 } }).reconnect)
      .toEqual({ runId: "active-run-1" });
    expect(parseRunAgentInput({ reconnect: { runId: "", afterSeq: 42 } }).reconnect).toBeUndefined();
  });
});
