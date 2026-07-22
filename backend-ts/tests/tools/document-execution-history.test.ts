import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type { DocumentEditHistoryPort } from "../../src/contracts/runtime/tool-ports.js";
import { PathApprovalService } from "../../src/services/runtime/path-approval-service.js";
import { LocalDocumentToolService } from "../../src/tools/DocumentTools/DocumentExecution.js";
import { toolContext } from "../helpers/tool-context.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("LocalDocumentToolService edit history", () => {
  it("waits for history tracking before writing the file", async () => {
    const dataRoot = createRoot();
    const target = path.join(dataRoot, "notes.txt");
    let release!: () => void;
    const tracked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const history: DocumentEditHistoryPort = {
      trackEdit: () => tracked,
    };
    const service = new LocalDocumentToolService({ dataRoot, fileHistory: history });

    const operation = service.writeFile(
      { filePath: "notes.txt", content: "new content" },
      context(dataRoot),
      agent(dataRoot),
      new PathApprovalService(),
    );
    await Promise.resolve();

    expect(fs.existsSync(target)).toBe(false);
    release();
    await expect(operation).resolves.toMatchObject({ success: true });
    expect(fs.readFileSync(target, "utf8")).toBe("new content");
  });

  it("does not edit a file when history tracking fails", async () => {
    const dataRoot = createRoot();
    const target = path.join(dataRoot, "notes.txt");
    fs.writeFileSync(target, "before", "utf8");
    const history: DocumentEditHistoryPort = {
      trackEdit: async () => {
        throw new Error("history unavailable");
      },
    };
    const service = new LocalDocumentToolService({ dataRoot, fileHistory: history });

    await expect(service.editFile(
      { filePath: "notes.txt", oldString: "before", newString: "after" },
      context(dataRoot),
      agent(dataRoot),
      new PathApprovalService(),
    )).resolves.toMatchObject({ success: false });
    expect(fs.readFileSync(target, "utf8")).toBe("before");
  });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-history-"));
  roots.push(root);
  return root;
}

function context(workspaceRoot: string): ToolExecContext {
  return toolContext({ sessionId: "session-1", runId: "run-1", workspaceRoot });
}

function agent(workspaceRoot: string): AgentConfig {
  return {
    agent_name: "document-history-test",
    enabled: true,
    default_entry: false,
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: { auto_inject: false, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: { workspace_root: workspaceRoot },
  };
}
