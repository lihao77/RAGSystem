import { describe, expect, it, vi } from "vitest";

import type { SessionFileLookupPort } from "../../src/contracts/session/session-file-storage.js";
import { AttachmentResolver } from "../../src/services/agent/execution/attachment-resolver.js";

const record = {
  id: "file-1",
  original_name: "photo.png",
  stored_name: "stored-photo.png",
  stored_path: "sessions/session-1/uploads/stored-photo.png",
  size: 42,
  mime: "image/png",
  uploaded_at: "2026-01-01T00:00:00.000Z",
  uploaded_by: null,
  indexed_in_vector: false,
  tags: null,
  notes: null,
  scope_type: "session" as const,
  scope_id: "session-1",
};

describe("AttachmentResolver", () => {
  it("resolves attachments through the asynchronous session-file port", async () => {
    const get = vi.fn<SessionFileLookupPort["get"]>().mockResolvedValue(record);
    const resolver = new AttachmentResolver({ get });

    await expect(resolver.resolve("session-1", [{ file_id: "file-1" }])).resolves.toEqual({
      attachments: [{
        file_id: "file-1",
        original_name: "photo.png",
        stored_name: "stored-photo.png",
        stored_path: "sessions/session-1/uploads/stored-photo.png",
        mime: "image/png",
        size: 42,
        kind: "image",
      }],
    });
    expect(get).toHaveBeenCalledWith("session-1", "file-1");
  });

  it("rejects files that are missing from the current session", async () => {
    const resolver = new AttachmentResolver({ get: vi.fn().mockResolvedValue(null) });

    await expect(resolver.resolve("session-1", [{ file_id: "missing" }])).resolves.toEqual({
      attachments: [],
      error: "附件不存在或不属于当前会话: missing",
    });
  });

  it("allows attachment-free requests without a configured lookup port", async () => {
    await expect(new AttachmentResolver().resolve("session-1", [])).resolves.toEqual({ attachments: [] });
  });
});
