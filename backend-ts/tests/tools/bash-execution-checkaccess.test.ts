import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalBashToolService } from "../../src/tools/BashTool/BashExecution.js";
import { createBashTools } from "../../src/tools/BashTool/BashTool.js";
import { LocalDocumentToolService } from "../../src/tools/DocumentTools/DocumentExecution.js";
import { createDocumentTools } from "../../src/tools/DocumentTools/DocumentTools.js";
import { PathApprovalService } from "../../src/services/runtime/path-service.js";
import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { EXECUTE_BASH_TOOL_NAME, READ_FILE_TOOL_NAME } from "../../src/services/runtime/runtime-tool-bridge/registry.js";
import { toolContext } from "../helpers/tool-context.js";

let dataRoot: string;
let external: string;

function ctx(over: Partial<ToolExecContext> = {}): ToolExecContext {
  return toolContext({ sessionId: "s1", runId: "r1", ...over });
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-bash-"));
  external = fs.mkdtempSync(path.join(os.tmpdir(), "rag-bash-out-"));
});
afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
});

describe("Bash 越界 workingDir 不被 checkAccess 提前 deny", () => {
  it("buildCommandClassification 不 resolve workingDir（越界也不失败）", () => {
    const service = new LocalBashToolService({ dataRoot });
    const classified = service.buildCommandClassification({ command: "ls", workingDir: external }, null);
    expect(classified.ok).toBe(true);
    if (classified.ok) {
      expect(classified.classification.command).toBe("ls");
      expect(classified.classification.workingDir).toBe(external);
    }
  });

  it("getExternalCandidates 为越界 workingDir 产候选（pathService 未 approve）", () => {
    const service = new LocalBashToolService({ dataRoot });
    const candidates = service.getExternalCandidates({ command: "ls", workingDir: external }, ctx(), new PathApprovalService());
    expect(candidates).toEqual([path.resolve(external)]);
  });

  it("pathService.approve 后 getExternalCandidates 不再产候选", () => {
    const service = new LocalBashToolService({ dataRoot });
    const pathService = new PathApprovalService();
    pathService.approve([external]);
    const candidates = service.getExternalCandidates({ command: "ls", workingDir: external }, ctx(), pathService);
    expect(candidates).toEqual([]);
  });

  it("prepareExecution 在未 approve 时对越界 workingDir 失败（resolve 抛）", () => {
    const service = new LocalBashToolService({ dataRoot });
    const prepared = service.prepareExecution({ command: "ls", workingDir: external }, ctx(), null, new PathApprovalService());
    expect(prepared.ok).toBe(false);
  });

  it("prepareExecution 在 approve 后对越界 workingDir 放行（resolve 通过）", () => {
    const service = new LocalBashToolService({ dataRoot });
    const pathService = new PathApprovalService();
    pathService.approve([external]);
    const prepared = service.prepareExecution({ command: "ls", workingDir: external }, ctx(), null, pathService);
    expect(prepared.ok).toBe(true);
  });

  it("仅路径越界时工具保留 candidatePaths 但不声明强制审批", () => {
    const pathService = new PathApprovalService();
    const bashTool = createBashTools({
      bashTools: new LocalBashToolService({ dataRoot }),
      agent: minimalAgent([EXECUTE_BASH_TOOL_NAME]),
      pathService,
    })[0]!;
    expect(bashTool.checkAccess?.({ command: "ls", working_dir: external }, ctx())).toMatchObject({
      action: "allow",
      signals: { candidatePaths: [path.resolve(external)] },
    });

    const target = path.join(external, "note.txt");
    const documentTool = createDocumentTools({
      documentTools: new LocalDocumentToolService({ dataRoot }),
      agent: minimalAgent([READ_FILE_TOOL_NAME]),
      pathService,
    })[0]!;
    expect(documentTool.checkAccess?.({ file_path: target }, ctx())).toMatchObject({
      action: "allow",
      signals: { candidatePaths: [path.resolve(target)] },
    });
  });
});

function minimalAgent(enabledTools: string[]): AgentConfig {
  return {
    agent_name: "path-policy-agent",
    display_name: "Path Policy Agent",
    description: null,
    enabled: true,
    default_entry: false,
    llm_tiers: {},
    tools: { enabled_tools: enabledTools },
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
    custom_params: {},
  };
}
