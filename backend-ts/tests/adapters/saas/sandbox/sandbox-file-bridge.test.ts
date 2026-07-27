import { describe, expect, it, vi } from "vitest";

import { SaaSSandboxFileBridge } from "../../../../src/adapters/saas/sandbox/sandbox-file-bridge.js";
import type { SandboxLease, SandboxOwner, SandboxProvider } from "../../../../src/contracts/sandbox/sandbox-provider.js";
import type { AsyncSessionFileStorage } from "../../../../src/contracts/session/session-file-storage.js";
import type { UploadedFileRecord } from "../../../../src/contracts/storage/files.js";

const owner: SandboxOwner = {
  tenantId: "tnt_a" as never,
  userId: "usr_a",
  sessionId: "session-a",
  runId: "run-a",
};
const lease: SandboxLease = { id: "sandbox-a", owner, createdAt: "2026-07-26T00:00:00.000Z" };

describe("SaaSSandboxFileBridge", () => {
  it("stages only tenant/session-authorized storage bytes and writes a manifest", async () => {
    const record = uploadedFile({ id: "file-a", original_name: "quarterly report.csv", size: 5 });
    const files = fakeStorage([record], new Map([[record.id, Buffer.from("hello")]]));
    const provider = fakeProvider();
    const bridge = new SaaSSandboxFileBridge(files);

    await bridge.prepare(lease, owner, provider, { attachmentFileIds: [record.id] });

    expect(files.list).toHaveBeenCalledWith("session-a");
    expect(files.read).toHaveBeenCalledWith("session-a", "file-a");
    const stage = vi.mocked(provider.stageInputFile);
    expect(stage).toHaveBeenCalledTimes(2);
    expect(stage.mock.calls[0]![1]).toMatchObject({
      path: "/input/uploads/file-a_input.txt",
      content: Buffer.from("hello").toString("base64"),
      encoding: "base64",
    });
    const manifestInput = stage.mock.calls[1]![1];
    expect(manifestInput.path).toBe("/input/uploads/.ragsystem-manifest.json");
    expect(JSON.parse(Buffer.from(manifestInput.content, "base64").toString("utf8"))).toEqual({
      files: [expect.objectContaining({
        file_id: "file-a",
        sandbox_path: "uploads/file-a_input.txt",
      })],
    });
  });

  it("rejects metadata outside the current session before reading or staging bytes", async () => {
    const record = uploadedFile({ scope_id: "session-b" });
    const files = fakeStorage([record]);
    const provider = fakeProvider();
    const bridge = new SaaSSandboxFileBridge(files);

    await expect(bridge.prepare(lease, owner, provider, { attachmentFileIds: [record.id] })).rejects.toThrow("outside the current session");
    expect(files.read).not.toHaveBeenCalled();
    expect(provider.stageInputFile).not.toHaveBeenCalled();
  });

  it("stages only attachment ids referenced by the active context", async () => {
    const selected = uploadedFile({ id: "selected", stored_name: "selected_input.txt" });
    const unrelated = uploadedFile({ id: "unrelated", stored_name: "unrelated_input.txt" });
    const files = fakeStorage(
      [selected, unrelated],
      new Map([[selected.id, Buffer.from("selected")], [unrelated.id, Buffer.from("unrelated")]]),
    );
    const provider = fakeProvider();
    const bridge = new SaaSSandboxFileBridge(files);

    await bridge.prepare(lease, owner, provider, { attachmentFileIds: [selected.id] });

    expect(files.read).toHaveBeenCalledTimes(1);
    expect(files.read).toHaveBeenCalledWith("session-a", selected.id);
    expect(provider.stageInputFile).not.toHaveBeenCalledWith(
      lease,
      expect.objectContaining({ path: "/input/uploads/unrelated_input.txt" }),
    );
  });

  it("collects bounded output files back into the same session storage", async () => {
    const files = fakeStorage([]);
    const provider = fakeProvider();
    vi.mocked(provider.glob).mockResolvedValue({ files: ["reports/final.csv"], truncated: false });
    vi.mocked(provider.readFile).mockResolvedValue({ content: Buffer.from("a,b\n1,2\n").toString("base64"), size: 8 });
    const bridge = new SaaSSandboxFileBridge(files, { maxOutputFileBytes: 1024 });

    await bridge.collectOutputs(lease, owner, provider);

    expect(provider.readFile).toHaveBeenCalledWith(lease, {
      path: "/output/reports/final.csv",
      encoding: "base64",
      maxBytes: 1024,
    });
    expect(files.add).toHaveBeenCalledWith("session-a", {
      originalName: "reports/final.csv",
      buffer: expect.any(Uint8Array),
      mime: "text/csv",
    });
    const added = vi.mocked(files.add).mock.calls[0]![1].buffer;
    expect(Buffer.from(added).toString("utf8")).toBe("a,b\n1,2\n");
  });

  it.each(["../other-tenant/secret.txt", "/etc/passwd", "C:\\Users\\other\\secret.txt"])(
    "rejects unsafe provider output path %s before reading or persisting output",
    async (unsafePath) => {
      const files = fakeStorage([]);
      const provider = fakeProvider();
      vi.mocked(provider.glob).mockResolvedValue({ files: [unsafePath], truncated: false });
      const bridge = new SaaSSandboxFileBridge(files);

      await expect(bridge.collectOutputs(lease, owner, provider)).rejects.toThrow(/invalid output path|unsafe output path/);
      expect(provider.readFile).not.toHaveBeenCalled();
      expect(files.add).not.toHaveBeenCalled();
    },
  );

  it("enforces input and output quotas", async () => {
    const record = uploadedFile({ size: 6 });
    const files = fakeStorage([record], new Map([[record.id, Buffer.from("123456")]]));
    const provider = fakeProvider();
    const inputBridge = new SaaSSandboxFileBridge(files, { maxInputFileBytes: 5 });
    await expect(inputBridge.prepare(lease, owner, provider, { attachmentFileIds: [record.id] })).rejects.toThrow("exceeds byte limit");

    vi.mocked(provider.glob).mockResolvedValue({ files: ["a.txt", "b.txt"], truncated: false });
    const outputBridge = new SaaSSandboxFileBridge(fakeStorage([]), { maxOutputFiles: 1 });
    await expect(outputBridge.collectOutputs(lease, owner, provider)).rejects.toThrow("file count exceeds limit");
  });
});

function uploadedFile(overrides: Partial<UploadedFileRecord> = {}): UploadedFileRecord {
  return {
    id: "file-a",
    original_name: "input.txt",
    stored_name: "file-a_input.txt",
    stored_path: "private/object-storage-key",
    size: 5,
    mime: "text/plain",
    uploaded_at: "2026-07-26T00:00:00.000Z",
    uploaded_by: null,
    indexed_in_vector: false,
    tags: null,
    notes: null,
    scope_type: "session",
    scope_id: "session-a",
    ...overrides,
  };
}

function fakeStorage(
  records: UploadedFileRecord[],
  bodies: Map<string, Uint8Array> = new Map(),
): AsyncSessionFileStorage {
  return {
    list: vi.fn(async () => records),
    get: vi.fn(async (_sessionId, fileId) => records.find((record) => record.id === fileId) ?? null),
    add: vi.fn(async (sessionId, input) => uploadedFile({
      id: "collected-output",
      original_name: input.originalName,
      stored_name: input.originalName.replace(/[\\/]/g, "_"),
      size: input.buffer.byteLength,
      mime: input.mime,
      scope_id: sessionId,
    })),
    delete: vi.fn(async () => null),
    read: vi.fn(async (_sessionId, fileId) => {
      const body = bodies.get(fileId);
      return body ? { body, contentType: "text/plain" } : null;
    }),
  };
}

function fakeProvider(): SandboxProvider {
  return {
    create: vi.fn(async () => lease),
    destroy: vi.fn(async () => undefined),
    stageInputFile: vi.fn(async (_lease, input) => ({ size: Buffer.from(input.content, "base64").byteLength })),
    readFile: vi.fn(async () => ({ content: "", size: 0 })),
    writeFile: vi.fn(async () => ({ size: 0 })),
    editFile: vi.fn(async () => ({ size: 0, replacements: 0 })),
    glob: vi.fn(async () => ({ files: [], truncated: false })),
    grep: vi.fn(async () => ({ matches: [], scannedFiles: 0, truncated: false })),
    previewFile: vi.fn(async () => ({ fileType: "text", fileSize: 0, structure: {} })),
    exec: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false })),
    executeCode: vi.fn(async () => ({ stdout: "", stderr: "", returnCode: 0, interrupted: false, result: null })),
  };
}
