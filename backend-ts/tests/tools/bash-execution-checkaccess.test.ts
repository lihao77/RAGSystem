import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalBashToolService } from "../../src/tools/BashTool/BashExecution.js";
import { PathApprovalService } from "../../src/services/runtime/path-service.js";
import type { ToolExecContext } from "@ragsystem/agent-sdk";
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
});
