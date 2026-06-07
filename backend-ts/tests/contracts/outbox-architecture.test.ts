import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve("src");

describe("outbox event architecture", () => {
  it("keeps business event delivery behind the durable outbox boundary", () => {
    const files = listTypeScriptFiles(srcRoot);
    const eventBusImportAllowed = new Set([
      normalize("src/services/runtime/event-bus.ts"),
      normalize("src/services/runtime/event-outbox/dispatcher.ts"),
      normalize("src/services/runtime/runtime-container.ts"),
    ]);
    const directPublishAllowed = new Set([
      normalize("src/services/runtime/event-outbox/dispatcher.ts"),
    ]);
    const historyReadAllowed = new Set([
      normalize("src/services/runtime/event-bus.ts"),
    ]);
    const subscribeAllowed = new Set([
      normalize("src/services/runtime/event-bus.ts"),
      normalize("src/routes/agent/ws.ts"),
    ]);

    const violations: string[] = [];

    for (const file of files) {
      const relativePath = normalize(path.relative(process.cwd(), file));
      const content = fs.readFileSync(file, "utf8");

      if (/\bInMemoryEventBus\b|event-bus\.js/.test(content) && !eventBusImportAllowed.has(relativePath)) {
        violations.push(`${relativePath}: imports or references InMemoryEventBus`);
      }
      if (/(?:this|container|options\.container)\.events\.publish\(/.test(content) && !directPublishAllowed.has(relativePath)) {
        violations.push(`${relativePath}: publishes directly to the in-memory event bus`);
      }
      if (/\.events\.getHistory\(|\bgetHistory\(/.test(content) && !historyReadAllowed.has(relativePath)) {
        violations.push(`${relativePath}: reads in-memory event history instead of durable outbox`);
      }
      if (/\.events\.subscribe\(|\bsubscribe\(/.test(content) && !subscribeAllowed.has(relativePath)) {
        violations.push(`${relativePath}: subscribes to the in-memory bus outside the WebSocket transport boundary`);
      }
    }

    expect(violations).toEqual([]);
  });
});

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/");
}
