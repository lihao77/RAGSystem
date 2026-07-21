import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("shared execution storage architecture", () => {
  it("keeps deployment and storage implementation selection outside the shared lifecycle", async () => {
    const files = [
      ...await collectTypeScriptFiles(join(sourceRoot, "services", "agent", "execution")),
      ...await collectTypeScriptFiles(join(sourceRoot, "services", "agent", "sdk")),
      join(sourceRoot, "app", "request-applications.ts"),
    ];
    const sources = await Promise.all(files.map(async (file) => ({
      file,
      source: await readFile(file, "utf8"),
    })));

    for (const { file, source } of sources) {
      expect(source, file).not.toMatch(/storage\.kind/);
      expect(source, file).not.toMatch(/deploymentKind/);
      expect(source, file).not.toMatch(/createConversationStore|createLocalExecutionStorage|sqlite-runtime-storage/);
    }
  });
});
