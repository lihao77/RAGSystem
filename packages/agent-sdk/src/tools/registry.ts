/**
 * 工具注册表——纯容器，收集 Tool 实例、查询、并发分类。
 *
 * 不做可见性过滤——"哪些工具对当前 agent 可见"是消费端决策。
 * 消费端在 per-run 构建 registry 时自行按 agent 配置筛选工具。
 */
import type { RuntimeToolDefinition } from "../prompt/tool-types.js";
import type { Tool } from "./tool.js";
import { toolToDefinition } from "./tool.js";
import { validateToolInput } from "./validation.js";

export interface ToolRegistryOptions {
  tools: Tool[];
}

export interface ToolRegistry {
  /** 列出注册表中的所有工具。 */
  listTools(): Tool[];
  /** 列出所有工具的 LLM 面定义。 */
  listDefinitions(): RuntimeToolDefinition[];
  /** 按名称查找工具。 */
  getTool(name: string): Tool | null;
  /** 并发分类：isReadOnly && isConcurrencySafe。 */
  classifyConcurrency(toolName: string, args: Record<string, unknown>): boolean;
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  const tools = [...options.tools];

  return {
    listTools() {
      return tools;
    },
    listDefinitions() {
      return tools.map(toolToDefinition);
    },
    getTool(name) {
      return tools.find((tool) => tool.name === name) ?? null;
    },
    classifyConcurrency(toolName, args) {
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) { return false; }
      const validation = validateToolInput(tool as Tool<Record<string, unknown>>, args);
      if (!validation.ok) { return false; }
      return tool.isReadOnly(validation.input) && tool.isConcurrencySafe(validation.input);
    },
  };
}
