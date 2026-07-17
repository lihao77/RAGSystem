import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/** 静态工具定义（配置驱动，tools/list 返回此形态；snake_case 对齐协议层 wire）。 */
export interface StaticTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  risk_level?: "low" | "medium" | "high";
}

interface ToolsFile {
  tools?: StaticTool[];
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 读 config/tools.yaml 静态工具清单。
 * build 产物 dist/ 运行时回溯到项目根 config/；可用 TOOLS_CONFIG 环境变量覆盖路径。
 */
export function loadStaticTools(configPath?: string): StaticTool[] {
  const path = configPath ?? process.env.TOOLS_CONFIG ?? resolve(here, "..", "config", "tools.yaml");
  const text = readFileSync(path, "utf-8");
  const parsed = parse(text) as ToolsFile;
  return parsed.tools ?? [];
}
