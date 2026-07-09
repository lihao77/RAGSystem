/**
 * 前端工具生态共享类型。
 *
 * 工具契约统一为 HostToolDeclaration：execute 不带 ctx、返回 ToolResult。
 * 这是对 agent-protocol DelegatedToolSpec 的"bridge 中立"子集——execute 无 ctx（bridge 转发场景
 * 传不了完整 DelegationContext），返回 ToolResult（与 DelegatedToolSpec 一致）。
 *
 * 统一形态的意义：同一份工具定义既能在主网页直接注册给 widget（HostToolDeclaration 结构兼容
 * DelegatedToolSpec，widget.registerHostTool 接受；ctx 由 widget 注入，工具可忽略），也能在嵌入网页
 * 经 iframe bridge 传递（serve 声明 → 上报元数据 → 主网页代理 execute=bridge.call）。
 * bridge 是纯传递管道，不另造工具接口（无 FrameTool）。
 */
import type { ToolResult } from "@ragsystem/agent-protocol";

/**
 * 宿主工具声明（bridge 中立）。
 * - 主网页：经 widget.registerHostTool 注册（结构兼容 DelegatedToolSpec；ctx 由 widget 注入，工具可忽略）
 * - 嵌入网页：经 frame-bridge serve 声明 → 上报元数据 → 主网页代理 execute=bridge.call
 *
 * execute 返回 ToolResult；observation 喂给 agent（语义对齐 delegate_result）。
 */
export interface HostToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel?: "low" | "medium" | "high";
  execute: (input: unknown) => Promise<ToolResult>;
}

/**
 * widget 元素的最小注册接口（结构兼容 RagWidgetHandle，避免 bridge 反向依赖 widget 包）。
 * bridge 转发场景：execute = (input) => bridge.call(name, input)。
 */
export interface HostToolRegistrar {
  registerHostTool: (spec: HostToolDeclaration) => () => void;
  unregisterHostTool?: (name: string) => void;
}
