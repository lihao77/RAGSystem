import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentExtractDispatcher } from "../../src/services/knowledge/document-extract/dispatcher.js";

const dispatcher = new DocumentExtractDispatcher({ engine: "builtin", cli: { command: "", timeout: 120, applies_to: [] }, http: { endpoint: "", timeout: 120, applies_to: [] } });
const fixture = (name: string) => path.join(import.meta.dirname, "..", ".test-data", name);

describe("DocumentExtractDispatcher", () => {
  it("按扩展名解析 PDF 与 DOCX 真夹具", async () => {
    const pdf = await dispatcher.extract({ file_path: fixture("sample.pdf"), file_name: "sample.pdf", mime: null });
    const docx = await dispatcher.extract({ file_path: fixture("sample.docx"), file_name: "sample.docx", mime: null });
    expect(pdf).toMatchObject({ kind: "pdf" });
    expect(docx).toMatchObject({ kind: "docx" });
    expect(pdf.markdown).not.toBe("");
    expect(docx.markdown).not.toBe("");
  });

  it("HTML、Markdown 与代码文件产出结构化 Markdown", async () => {
    const htmlPath = fixture("extract-sample.html");
    const mdPath = fixture("extract-sample.md");
    const codePath = fixture("extract-sample.ts");
    await fs.writeFile(htmlPath, "<h1>标题</h1><ul><li>条目</li></ul>");
    await fs.writeFile(mdPath, "# 原样标题\n\n- 原样列表");
    await fs.writeFile(codePath, "const answer = 42;");
    try {
      await expect(dispatcher.extract({ file_path: htmlPath, file_name: "sample.html" })).resolves.toMatchObject({ markdown: expect.stringContaining("# 标题") });
      await expect(dispatcher.extract({ file_path: mdPath, file_name: "sample.md" })).resolves.toMatchObject({ markdown: "# 原样标题\n\n- 原样列表" });
      await expect(dispatcher.extract({ file_path: codePath, file_name: "sample.ts" })).resolves.toMatchObject({ markdown: expect.stringContaining("```typescript") });
    } finally {
      await Promise.all([htmlPath, mdPath, codePath].map((filePath) => fs.rm(filePath, { force: true })));
    }
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
