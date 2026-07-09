import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { ToolResult } from "@ragsystem/agent-protocol";
import type { StaticTool } from "./config.js";

/** 前端 register 推来的单工具声明（snake_case，对齐静态清单 input_schema）。 */
export interface DeclaredTool {
  name: string;
  input_schema: Record<string, unknown>;
}

interface SessionState {
  ws: WebSocket;
  tools: Map<string, DeclaredTool>;
}

interface PendingCall {
  resolve: (r: ToolResult) => void;
  timer: NodeJS.Timeout;
}

const CALL_TIMEOUT_MS = 60_000;

/**
 * 路由核心：session→前端WS 映射 + 静态 schema 比对 + MCP tools/call 下发 invoke 并等 result。
 * 无执行端/schema 不匹配/超时 → 返回软失败 ToolResult（observation 文本，对标 delegate 失败分支）。
 */
export class Router {
  private readonly sessions = new Map<string, SessionState>();
  private readonly wsToSessions = new Map<WebSocket, Set<string>>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly staticTools = new Map<string, StaticTool>();

  constructor(staticTools: StaticTool[]) {
    for (const t of staticTools) this.staticTools.set(t.name, t);
  }

  /** 前端注册：逐工具比对静态 schema（不一致告警，不阻断），覆盖式存 session→ws 路由。 */
  register(sessionId: string, ws: WebSocket, declared: DeclaredTool[]): void {
    for (const tool of declared) {
      const staticDef = this.staticTools.get(tool.name);
      if (staticDef && !schemaEqual(staticDef.input_schema, tool.input_schema)) {
        console.warn(
          `[router] session ${sessionId} 工具 ${tool.name} schema 与静态清单不一致——前端声明与配置漂移`,
        );
      }
    }
    this.sessions.set(sessionId, { ws, tools: new Map(declared.map((t) => [t.name, t])) });
    let set = this.wsToSessions.get(ws);
    if (!set) {
      set = new Set();
      this.wsToSessions.set(ws, set);
    }
    set.add(sessionId);
    console.log(`[router] session ${sessionId} 注册 ${declared.length} 个工具`);
  }

  /** 前端 WS 断开：清理该 ws 关联的全部 session（pending 由超时兜底）。 */
  disconnect(ws: WebSocket): void {
    const sids = this.wsToSessions.get(ws);
    if (!sids) return;
    for (const sid of sids) {
      this.sessions.delete(sid);
      console.log(`[router] session ${sid} 断开`);
    }
    this.wsToSessions.delete(ws);
  }

  /** MCP tools/call：查路由 → 下发 invoke → 等 result。 */
  async invoke(sessionId: string | undefined, toolName: string, args: unknown): Promise<ToolResult> {
    if (!sessionId) {
      return { ok: false, observation: "缺少 session_id（_meta.session_id），无法路由到执行端" };
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      return { ok: false, observation: `无可用执行端：session ${sessionId} 未连接前端工具 MCP client` };
    }
    if (!state.tools.has(toolName)) {
      return { ok: false, observation: `工具 ${toolName} 未被 session ${sessionId} 声明（schema 不匹配或未注册）` };
    }
    if (state.ws.readyState !== state.ws.OPEN) {
      return { ok: false, observation: `session ${sessionId} 执行端 WS 未就绪` };
    }
    const callId = randomUUID();
    const startedAt = Date.now();
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ ok: false, observation: `前端执行超时（${CALL_TIMEOUT_MS}ms）`, error: "timeout", elapsedMs: Date.now() - startedAt });
      }, CALL_TIMEOUT_MS);
      this.pending.set(callId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        timer,
      });
      state.ws.send(JSON.stringify({ type: "invoke", call_id: callId, tool: toolName, input: args ?? {} }));
    });
  }

  /** 前端回传 result：resolve 对应 pending。 */
  deliverResult(callId: string, result: ToolResult): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    pending.resolve(result);
  }
}

/** 浅比 JSON schema（声明式 JSON，直接序列化比对；前端声明与配置同源时一致）。 */
function schemaEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
