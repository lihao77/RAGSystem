/**
 * 前端宿主委托工具：声明本连接可委托执行的工具 + execute 实现。
 *
 * WS 握手期 onopen 发 tools.register（getHostToolDeclarations）；收到 delegate_call(phase=request)
 * 时按 tool 名路由 getHostTool(name).execute，执行完回传 delegate_result(phase=result)。
 *
 * 工具用客户端独有能力（浏览器环境/本地资源），后端无法执行——这正是委托模式的价值。
 */

const HOST_TOOLS = [
  {
    name: 'get_client_env',
    description:
      '获取前端客户端环境信息（时区、语言、浏览器 User-Agent、屏幕分辨率等客户端独有数据）。当需要用户客户端环境上下文（如本地化、展示适配）时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'low',
    async execute() {
      const nav = globalThis.navigator || {};
      const lang = nav.language || 'unknown';
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
      const ua = nav.userAgent || 'unknown';
      const screen = globalThis.screen ? `${globalThis.screen.width}x${globalThis.screen.height}` : 'unknown';
      return {
        ok: true,
        observation: JSON.stringify({ language: lang, timezone: tz, userAgent: ua, screen }, null, 2),
      };
    },
  },
];

const toolMap = new Map(HOST_TOOLS.map((tool) => [tool.name, tool]));

/** wire 声明（tools.register 用，不含 execute 函数——函数不可序列化）。 */
export function getHostToolDeclarations() {
  return HOST_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.riskLevel ? { risk_level: tool.riskLevel } : {}),
  }));
}

export function getHostTool(name) {
  return toolMap.get(name) || null;
}
