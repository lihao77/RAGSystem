import { describe, expect, it, vi } from "vitest";

import type { SessionFileLookupPort } from "../src/contracts/session/session-file-storage.js";
import { AttachmentResolver } from "../src/services/agent/execution/attachment-resolver.js";

const record = {
  id: "file-nc",
  original_name: "ocean.nc",
  stored_name: "ocean.nc",
  stored_path: "D:\\data\\ocean.nc",
  size: 42,
  mime: "application/x-netcdf",
  uploaded_at: "2026-01-01T00:00:00.000Z",
  uploaded_by: null,
  indexed_in_vector: false,
  tags: null,
  notes: null,
  scope_type: "session" as const,
  scope_id: "session-1",
  storage_kind: "linked_local" as const,
  local_path: "D:\\data\\ocean.nc",
};

describe("AttachmentResolver", () => {
  it.each([
    ["image/png", "photo.png", "image"], ["image/jpeg", "photo.jpg", "image"],
    ["image/webp", "photo.webp", "image"], ["image/gif", "photo.gif", "image"],
    ["", "photo.png", "image"], ["image/tiff", "scan.tif", "file"],
    ["image/tiff", "scan.tiff", "file"], ["image/png", "scan.tif", "file"],
    ["image/bmp", "photo.bmp", "file"], ["image/svg+xml", "vector.svg", "file"],
  ])("classifies stored %s / %s without trusting a client image flag", async (mime, original_name, kind) => {
    const resolver = new AttachmentResolver({
      get: vi.fn().mockResolvedValue({ ...record, mime, original_name }), read: vi.fn(),
    });
    const result = await resolver.resolve("session-1", [{ file_id: record.id }]);
    expect(result.attachments[0]?.kind).toBe(kind);
    if (!mime) expect(result.attachments[0]?.mime).toBe("image/png");
  });

  it("projects a server-authorized local link as an absolute attachment path", async () => {
    const get = vi.fn<SessionFileLookupPort["get"]>().mockResolvedValue(record);
    const resolver = new AttachmentResolver({ get, read: vi.fn().mockResolvedValue(null) });

    await expect(resolver.resolve("session-1", [{ file_id: "file-nc" }])).resolves.toEqual({
      attachments: [expect.objectContaining({
        file_id: "file-nc",
        file_path: "D:\\data\\ocean.nc",
        file_path_space: "absolute",
      })],
    });
    expect(get).toHaveBeenCalledWith("session-1", "file-nc");
  });

  it("rejects a file id that the current session cannot resolve", async () => {
    const resolver = new AttachmentResolver({
      get: vi.fn().mockResolvedValue(null),
      read: vi.fn().mockResolvedValue(null),
    });

    await expect(resolver.resolve("session-1", [{ file_id: "missing" }])).resolves.toEqual({
      attachments: [],
      error: "附件不存在或不属于当前会话: missing",
    });
  });
});
