import type { HostToolDeclaration, ToolResult } from "@ragsystem/agent-protocol";

const WS_OPEN = 1;
const MAX_RECONNECT_ATTEMPTS = 10;

export interface RagMcpClientOptions {
  /** MCP server 执行端 WS 地址（ws://host:port/ws）。 */
  url: string;
  /** 会话 id：register 时上报，server 据此路由 tools/call 的 _meta.session_id。 */
  sessionId: string;
}

/**
 * 前端工具 MCP 执行端 client（widget 独立 UMD：ragsystem-mcp-client.umd.cjs，全局 RagMcpClient）。
 *
 * 连 MCP server 的 /ws：上报工具清单（register，session_id + 工具声明），收 invoke 调 host-tools
 * execute，回 result。骨架对标 useSessionAgentClient.connectSessionWS（指数退避重连）+ handleDelegateCall
 * （收指令→execute→回传）。工具声明复用 HostToolDeclaration（dom/map 工厂产出）。
 *
 * 用法（拿到 session_id 后）：
 *   const c = new RagMcpClient.RagMcpClient({ url: "ws://localhost:8787/ws", sessionId });
 *   c.registerTools(RagHostTools.dom.BUILTIN_TOOLS);
 *   c.connect();
 */
export class RagMcpClient {
  private ws: WebSocket | null = null;
  private readonly tools = new Map<string, HostToolDeclaration>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;

  constructor(private readonly options: RagMcpClientOptions) {}

  /** 注册单个工具（增量；已连接则立即上报全量 register）。返回取消注册函数。 */
  registerTool(declaration: HostToolDeclaration): () => void {
    this.tools.set(declaration.name, declaration);
    this.sendRegister();
    return () => {
      this.tools.delete(declaration.name);
      this.sendRegister();
    };
  }

  /** 批量注册。返回取消全部注册的函数。 */
  registerTools(declarations: HostToolDeclaration[]): () => void {
    const unsubs = declarations.map((d) => this.registerTool(d));
    return () => unsubs.forEach((u) => u());
  }

  /** 连接 MCP server（带指数退避重连）。 */
  connect(): void {
    this.manualClose = false;
    this.openSocket();
  }

  /** 主动断开（不再重连）。 */
  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private openSocket(): void {
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.sendRegister();
    };
    ws.onmessage = (event) => this.handleMessage(event);
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.manualClose) return;
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn(`[RagMcpClient] 达到最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，放弃`);
        return;
      }
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000) + Math.random() * 1000;
      this.reconnectAttempts += 1;
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };
    ws.onerror = () => {};
  }

  private handleMessage(event: MessageEvent): void {
    let msg: { type?: string; call_id?: string; tool?: string; input?: unknown };
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (msg.type !== "invoke" || !msg.call_id || !msg.tool) return;
    void this.runTool(msg.call_id, msg.tool, msg.input);
  }

  private async runTool(callId: string, toolName: string, input: unknown): Promise<void> {
    const startedAt = Date.now();
    const decl = this.tools.get(toolName);
    if (!decl) {
      this.sendResult(callId, { ok: false, observation: `未注册工具: ${toolName}`, elapsedMs: 0 });
      return;
    }
    try {
      const result: ToolResult = await decl.execute(input);
      this.sendResult(callId, {
        ok: result.ok !== false,
        observation: typeof result.observation === "string" ? result.observation : "",
        ...(result.error ? { error: result.error } : {}),
        elapsedMs: Date.now() - startedAt,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.sendResult(callId, { ok: false, observation: text, error: text, elapsedMs: Date.now() - startedAt });
    }
  }

  private sendRegister(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const tools = Array.from(this.tools.values()).map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema,
      ...(d.riskLevel ? { risk_level: d.riskLevel } : {}),
    }));
    this.ws.send(JSON.stringify({ type: "register", session_id: this.options.sessionId, tools }));
  }

  private sendResult(callId: string, result: ToolResult): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: "result",
        call_id: callId,
        ok: result.ok,
        observation: result.observation,
        ...(result.error ? { error: result.error } : {}),
        elapsed_ms: result.elapsedMs ?? 0,
      }),
    );
  }
}
