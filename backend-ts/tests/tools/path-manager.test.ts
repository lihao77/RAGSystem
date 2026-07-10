import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LocalDocumentPathManager } from "../../src/tools/DocumentTools/path-manager.js";
import { PathApprovalService } from "../../src/services/runtime/path-service.js";
import type { ToolExecContext } from "@ragsystem/agent-sdk";
import { toolContext } from "../helpers/tool-context.js";

const sessionId = "sess-test";
const runId = "run-test";
let dataRoot: string;
let externalWs: string;

function ctx(over: Partial<ToolExecContext> = {}): ToolExecContext {
  return toolContext({ sessionId, runId, ...over });
}

beforeAll(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rag-pm-"));
  externalWs = fs.mkdtempSync(path.join(os.tmpdir(), "rag-pm-ws-"));
  const sessionRoot = path.join(dataRoot, "sessions", sessionId);
  for (const sub of ["workspace", "uploads", "transient", "exports"]) {
    fs.mkdirSync(path.join(sessionRoot, sub, runId), { recursive: true });
  }
  fs.writeFileSync(path.join(sessionRoot, "uploads", "u.txt"), "u");
});

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(externalWs, { recursive: true, force: true });
});

describe("LocalDocumentPathManager 越界守卫", () => {
  it("写操作命中 dataRoot 外的绝对路径 → 抛错", () => {
    const evil = process.platform === "win32" ? "C:\\Windows\\evil.txt" : "/etc/evil";
    expect(() =>
      new LocalDocumentPathManager(dataRoot).resolveManagedPath(evil, { context: ctx(), operation: "write" }, new PathApprovalService()),
    ).toThrow(/超出允许的受管目录范围/);
  });

  it("../ 相对逃逸 → 抛错", () => {
    expect(() =>
      new LocalDocumentPathManager(dataRoot).resolveManagedPath("../../../../etc/passwd", {
        context: ctx(),
        operation: "read",
      }, new PathApprovalService()),
    ).toThrow(/超出允许的受管目录范围/);
  });

  it("./data/ 前缀落到 workspace → write 放行", () => {
    const p = new LocalDocumentPathManager(dataRoot).resolveManagedPath(
      `./data/sessions/${sessionId}/workspace/x.txt`,
      { context: ctx(), operation: "write" },
      new PathApprovalService(),
    );
    expect(p).toContain(path.join("sessions", sessionId, "workspace"));
  });

  it("写操作不能落到 uploads(只读区) → 抛错", () => {
    expect(() =>
      new LocalDocumentPathManager(dataRoot).resolveManagedPath(
        `./data/sessions/${sessionId}/uploads/a.txt`,
        { context: ctx(), operation: "write" },
        new PathApprovalService(),
      ),
    ).toThrow(/超出允许的受管目录范围/);
  });

  it("read 可读 uploads 区 → 放行", () => {
    const p = new LocalDocumentPathManager(dataRoot).resolveManagedPath(
      `./data/sessions/${sessionId}/uploads/u.txt`,
      { context: ctx(), operation: "read" },
      new PathApprovalService(),
    );
    expect(p.endsWith(path.join("sessions", sessionId, "uploads", "u.txt"))).toBe(true);
  });
});

describe("PathApprovalService 已批准路径放行", () => {
  it("未批准的外部绝对路径 → 抛错", () => {
    expect(() =>
      new LocalDocumentPathManager(dataRoot).resolveManagedPath(path.join(externalWs, "note.txt"), {
        context: ctx(),
        operation: "read",
      }, new PathApprovalService()),
    ).toThrow(/超出允许的受管目录范围/);
  });

  it("pathService.approve 批准后 → 外部路径放行", () => {
    const target = path.join(externalWs, "note.txt");
    const pathService = new PathApprovalService();
    pathService.approve([externalWs]);
    const p = new LocalDocumentPathManager(dataRoot).resolveManagedPath(target, {
      context: ctx(),
      operation: "read",
    }, pathService);
    expect(p).toBe(path.resolve(target));
  });
});

describe("workspaceRoot 注入", () => {
  it("ctx.workspaceRoot 指向外部目录 → 该目录下 write 放行", () => {
    const target = path.join(externalWs, "out.txt");
    const p = new LocalDocumentPathManager(dataRoot).resolveManagedPath(target, {
      context: ctx({ workspaceRoot: externalWs }),
      operation: "write",
    }, new PathApprovalService());
    expect(p).toBe(path.resolve(target));
  });

  it("无 workspaceRoot → write 回落到 session 默认 workspace 子目录", () => {
    const p = new LocalDocumentPathManager(dataRoot).resolveManagedPath("rel.txt", {
      context: ctx(),
      operation: "write",
    }, new PathApprovalService());
    expect(p).toContain(path.join("sessions", sessionId, "workspace"));
  });

  it("无 workspaceRoot + 无 sessionId → 无可用工作区根,写相对路径抛错", () => {
    expect(() =>
      new LocalDocumentPathManager(dataRoot).resolveManagedPath("rel.txt", {
        context: ctx({ sessionId: null }),
        operation: "write",
      }, new PathApprovalService()),
    ).toThrow(/缺少可用的受管根目录|路径/);
  });
});
