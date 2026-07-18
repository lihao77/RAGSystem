import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const srcRoot = path.resolve("src");

describe("outbox event architecture", () => {
  it("keeps business event delivery behind the durable outbox boundary", () => {
    const files = listTypeScriptFiles(srcRoot);
    const realtimeHubImportAllowed = new Set([
      normalize("src/services/runtime/realtime-event-hub.ts"),
      normalize("src/services/runtime/event-outbox/dispatcher.ts"),
      normalize("src/services/runtime/local-runtime-container.ts"),
      normalize("src/services/runtime/runtime-container-contracts.ts"),
    ]);
    const directPublishAllowed = new Set([
      normalize("src/services/runtime/event-outbox/dispatcher.ts"),
    ]);
    const historyReadAllowed = new Set([
      normalize("src/services/runtime/realtime-event-hub.ts"),
    ]);
    const subscribeAllowed = new Set([
      normalize("src/services/runtime/realtime-event-hub.ts"),
      normalize("src/routes/agent/ws.ts"),
      normalize("src/services/agui-gateway/agui-handler.ts"),
    ]);

    const violations: string[] = [];

    for (const file of files) {
      const relativePath = normalize(path.relative(process.cwd(), file));
      const content = fs.readFileSync(file, "utf8");

      if (/\bRealtimeEventHub\b|realtime-event-hub\.js/.test(content) && !realtimeHubImportAllowed.has(relativePath)) {
        violations.push(`${relativePath}: imports or references RealtimeEventHub`);
      }
      if (/(?:this|container|options\.container)\.realtimeEvents\.publish\(/.test(content) && !directPublishAllowed.has(relativePath)) {
        violations.push(`${relativePath}: publishes directly to the realtime event hub`);
      }
      if (/\.realtimeEvents\.getHistory\(|\bgetHistory\(/.test(content) && !historyReadAllowed.has(relativePath)) {
        violations.push(`${relativePath}: reads realtime event history instead of durable outbox`);
      }
      if (/\.realtimeEvents\.subscribe\(|\bsubscribe\(/.test(content) && !subscribeAllowed.has(relativePath)) {
        violations.push(`${relativePath}: subscribes to the realtime hub outside the WebSocket transport boundary`);
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
