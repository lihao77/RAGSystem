import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DocumentExtractor, ExtractResult } from "../../../../contracts/knowledge/document-extractor.js";
import { terminateProcessTree } from "../../../runtime/process-tree.js";

export class CliExtractor implements DocumentExtractor {
  constructor(
    private readonly command: string,
    private readonly timeoutSeconds: number,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly terminateProcess: typeof terminateProcessTree = terminateProcessTree,
  ) {}

  async extract(input: Parameters<DocumentExtractor["extract"]>[0]): Promise<ExtractResult> {
    const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ragsystem-extract-"));
    try {
      const command = this.command.replaceAll("{input}", quoteShell(input.file_path)).replaceAll("{output}", quoteShell(outputDirectory));
      await runCommand(command, this.timeoutSeconds * 1000, this.spawnProcess, this.terminateProcess);
      const markdownPath = await findLatestMarkdown(outputDirectory);
      if (!markdownPath) throw new Error("CLI document extractor produced no Markdown file");
      return { text: await fs.readFile(markdownPath, "utf8"), kind: "text" };
    } finally {
      await fs.rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

function runCommand(command: string, timeoutMs: number, spawnProcess: typeof spawn, terminateProcess: typeof terminateProcessTree): Promise<void> {
  return new Promise((resolve, reject) => {
    const [executable, args] = process.platform === "win32" ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/sh", ["-c", command]];
    const child: ChildProcess = spawnProcess(executable, args, { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    const timer = setTimeout(() => { terminateProcess(child.pid, false); setTimeout(() => terminateProcess(child.pid, true), 500); reject(new Error(`CLI document extractor timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(stderr.trim() || `CLI document extractor exited with code ${code}`)); });
  });
}

async function findLatestMarkdown(root: string): Promise<string | null> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
  const candidates = await Promise.all(files.map(async (entry) => {
    const filePath = path.join(entry.parentPath, entry.name);
    return { filePath, modified: (await fs.stat(filePath)).mtimeMs };
  }));
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.filePath ?? null;
}

function quoteShell(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}
