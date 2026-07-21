import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function walkTsFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walkTsFiles(fullPath));
    else if (entry.name.endsWith(".ts")) result.push(fullPath);
  }
  return result;
}

function readJoined(root: string): string {
  return walkTsFiles(root).map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

describe("service storage boundaries", () => {
  it("keeps concrete vector and team adapters outside services", () => {
    const servicesRoot = path.resolve("src/services");
    const source = readJoined(servicesRoot);

    expect(source).not.toMatch(/node:sqlite|from ["']pg["']|sqlite-vec/);
    expect(source).not.toMatch(/from ["'][^"']*adapters\//);
    expect(fs.existsSync(path.resolve("src/adapters/local/vector-store/sqlite-vec-driver.ts"))).toBe(true);
    expect(fs.existsSync(path.resolve("src/adapters/filesystem/agent/file-team-store.ts"))).toBe(true);
    expect(fs.existsSync(path.resolve("src/services/vector-store/sqlite-vec"))).toBe(false);
    expect(fs.existsSync(path.resolve("src/adapters/saas/postgres/knowledge-query-adapter.ts"))).toBe(false);
  });

  it("keeps filesystem team store free of services imports", () => {
    const filesystemRoot = path.resolve("src/adapters/filesystem");
    const source = readJoined(filesystemRoot);
    expect(source).not.toMatch(/from ["'][^"']*services\//);
  });

  it("keeps pure agent config helpers in contracts", () => {
    expect(fs.existsSync(path.resolve("src/contracts/agent/config-normalize.ts"))).toBe(true);
    expect(fs.existsSync(path.resolve("src/contracts/agent/team-store.ts"))).toBe(true);
  });
});
