import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentExtractDispatcher } from "../../src/services/knowledge/document-extract/dispatcher.js";

const dispatcher = new DocumentExtractDispatcher({ engine: "builtin", cli: { command: "", timeout: 120, applies_to: [] }, http: { endpoint: "", timeout: 120, applies_to: [] } });
const fixture = (name: string) => path.join(import.meta.dirname, "..", ".test-data", name);

describe("DocumentExtractDispatcher", () => {
  it("按扩展名解析 PDF 与 DOCX 真夹具", async () => {
    await expect(dispatcher.extract({ file_path: fixture("sample.pdf"), file_name: "sample.pdf", mime: null })).resolves.toMatchObject({ kind: "pdf" });
    await expect(dispatcher.extract({ file_path: fixture("sample.docx"), file_name: "sample.docx", mime: null })).resolves.toMatchObject({ kind: "docx" });
  });

  it("无扩展名时按魔数识别 PDF", async () => {
    const source = await fs.readFile(fixture("sample.pdf"));
    const target = fixture("sample-magic");
    await fs.writeFile(target, source);
    try { await expect(dispatcher.extract({ file_path: target, mime: null })).resolves.toMatchObject({ kind: "pdf" }); }
    finally { await fs.rm(target, { force: true }); }
  });

  it("未知二进制 fail-closed 415", async () => {
    const target = fixture("unknown.bin");
    await fs.writeFile(target, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]));
    try { await expect(dispatcher.extract({ file_path: target, mime: "application/octet-stream" })).rejects.toMatchObject({ statusCode: 415 }); }
    finally { await fs.rm(target, { force: true }); }
  });
});
