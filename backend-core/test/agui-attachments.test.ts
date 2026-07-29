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
