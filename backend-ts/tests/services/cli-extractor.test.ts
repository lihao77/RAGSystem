import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
const terminateMock = vi.fn();
import { CliExtractor } from "../../src/services/knowledge/document-extract/external/cli-extractor.js";

function childProcess(pid = 123) {
  const child = new EventEmitter() as EventEmitter & { pid: number; stderr: PassThrough };
  child.pid = pid;
  child.stderr = new PassThrough();
  return child;
}

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("CliExtractor", () => {
  it("替换占位符并读取最新 Markdown", async () => {
    const child = childProcess();
    spawnMock.mockImplementation((_exe, args: string[]) => {
      const command = args.at(-1)!;
      const quoted = [...command.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
      const output = quoted.at(-1)!;
      void fs.writeFile(path.join(output, "result.md"), "parsed markdown").then(() => child.emit("close", 0));
      return child;
    });
    const result = await new CliExtractor("tool -p {input} -o {output}", 5, spawnMock).extract({ file_path: "C:\\input docs\\a.pdf" });
    expect(result.text).toBe("parsed markdown");
    expect(spawnMock.mock.calls[0]![1].at(-1)).toContain("input docs");
  });

  it("非零退出码抛 stderr", async () => {
    const child = childProcess();
    spawnMock.mockReturnValue(child);
    const promise = new CliExtractor("tool {input} {output}", 5, spawnMock).extract({ file_path: "a.pdf" });
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.stderr.write("bad input");
    child.emit("close", 2);
    await expect(promise).rejects.toThrow("bad input");
  });

  it("超时终止进程树", async () => {
    const child = childProcess(456);
    spawnMock.mockReturnValue(child);
    const promise = new CliExtractor("tool {input} {output}", 0.01, spawnMock, terminateMock).extract({ file_path: "a.pdf" });
    await expect(promise).rejects.toThrow("timed out");
    expect(terminateMock).toHaveBeenCalledWith(456, false);
  });
});
