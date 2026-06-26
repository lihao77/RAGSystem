/**
 * 工具格式化（迁自 backend-ts tool-format.ts）。
 * prepareToolsForPrompt 接收 backgroundTasks 标志（替代 agent.tasks.background 读取），决定是否裁剪 run_in_background 参数。
 */
import type { ToolInstructionMode } from "../contracts.js";
import type { RuntimeToolDefinition } from "./tool-types.js";
import { isRecord, normalizeString } from "./types.js";

export function prepareToolsForPrompt(tools: RuntimeToolDefinition[], backgroundTasks = false): RuntimeToolDefinition[] {
  if (backgroundTasks) {
    return tools;
  }
  return tools.map((tool) => omitBackgroundParameters(tool));
}

function omitBackgroundParameters(tool: RuntimeToolDefinition): RuntimeToolDefinition {
  const parameters = tool.parameters;
  if (!isRecord(parameters.properties) || !Object.prototype.hasOwnProperty.call(parameters.properties, "run_in_background")) {
    return tool;
  }
  const properties = { ...parameters.properties };
  delete properties.run_in_background;
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties,
    },
  };
}

export function formatToolParameters(parameters: Record<string, unknown>): string[] {
  if (!isRecord(parameters.properties)) {
    return [];
  }
  const required = Array.isArray(parameters.required) ? parameters.required.map(String) : [];
  const lines = ["**参数**:"];
  for (const [paramName, rawInfo] of Object.entries(parameters.properties)) {
    const paramInfo = isRecord(rawInfo) ? rawInfo : {};
    const paramType = normalizeString(paramInfo.type) ?? "any";
    const paramDesc = normalizeString(paramInfo.description) ?? "";
    const requiredMark = required.includes(paramName) ? " (必填)" : " (可选)";
    lines.push(`  - \`${paramName}\` (${paramType})${requiredMark}: ${paramDesc}`);
  }
  return lines;
}

export function formatAllowedCallers(tool: RuntimeToolDefinition, mode: ToolInstructionMode = "xml"): string {
  const isNative = mode === "native";
  const directLabel = isNative ? "direct（可用 function calling 调用）" : "direct（可直接调用）";
  const labels: string[] = [];
  const allowedCallers = getAllowedCallers(tool);
  if (allowedCallers.includes("direct")) {
    labels.push(directLabel);
  }
  if (allowedCallers.includes("code_execution")) {
    labels.push("code_execution（可在 execute_code 中通过 call_tool 调用）");
  }
  for (const caller of allowedCallers) {
    if (caller !== "direct" && caller !== "code_execution") {
      labels.push(`${caller}（自定义调用来源）`);
    }
  }
  return labels.length ? labels.join("、") : directLabel;
}

export function getAllowedCallers(tool: RuntimeToolDefinition): string[] {
  const callers = Array.isArray(tool.allowed_callers) ? tool.allowed_callers.map(String).filter(Boolean) : [];
  return callers.length ? callers : ["direct"];
}

export function parameterNames(tool: RuntimeToolDefinition): string[] {
  return isRecord(tool.parameters.properties) ? Object.keys(tool.parameters.properties) : [];
}

export function formatToolContract(tool: RuntimeToolDefinition, includeExamples: boolean): string[] {
  const lines: string[] = [];
  const extendedUsage = normalizeString(tool.extended_usage);
  if (extendedUsage) {
    lines.push(extendedUsage);
    lines.push("");
  }
  if (tool.returns) {
    lines.push("**成功返回**:");
    const returnDescription = normalizeString(tool.returns.description);
    if (returnDescription) {
      lines.push(`  - ${returnDescription}`);
    }
    if (Object.prototype.hasOwnProperty.call(tool.returns, "shape")) {
      lines.push(`  \`\`\`json\n  ${stringifyJsonForPrompt(tool.returns.shape, 2)}\n  \`\`\``);
    }
  }
  const usageContract = Array.isArray(tool.usage_contract) ? tool.usage_contract.filter((item) => item.trim()) : [];
  if (usageContract.length) {
    lines.push("**使用约束**:");
    for (const item of usageContract) {
      lines.push(`  - ${item}`);
    }
  }
  if (includeExamples) {
    const examples = Array.isArray(tool.examples) ? tool.examples.filter(isRecord) : [];
    if (examples.length) {
      lines.push("**示例**:");
      for (const example of examples) {
        lines.push(renderToolExampleFromContract(example, tool.name));
      }
    } else {
      lines.push("**示例**:");
      lines.push(renderToolExample(tool));
    }
  }
  return lines;
}

function renderToolExample(tool: RuntimeToolDefinition): string {
  const properties = isRecord(tool.parameters.properties) ? tool.parameters.properties : {};
  const required = Array.isArray(tool.parameters.required) ? tool.parameters.required.map(String) : [];
  const paramNames = required.length ? required : Object.keys(properties).slice(0, 2);
  const renderedParams = paramNames.length
    ? paramNames.map((name) => `  <${name}>${exampleValueForParam(name, properties[name])}</${name}>`).join("\n")
    : "  <param_name>value</param_name>";
  return `  \`\`\`xml\n  <tool name="${tool.name}">\n${renderedParams}\n  </tool>\n  \`\`\``;
}

function renderToolExampleFromContract(example: Record<string, unknown>, toolName: string): string {
  const rawParams = isRecord(example.input) ? example.input : example;
  const extraEntries = Object.entries(example).filter(([key]) => key !== "input" && key !== "xml_attrs");
  const xmlAttrs = isRecord(example.xml_attrs) ? example.xml_attrs : {};
  const renderedParams = Object.entries(rawParams)
    .map(([key, value]) => renderToolExampleParam(key, value, isRecord(xmlAttrs[key]) ? xmlAttrs[key] : {}))
    .join("\n");
  let block = `  \`\`\`xml\n  <tool name="${toolName}">\n${renderedParams}\n  </tool>\n  \`\`\``;
  if (extraEntries.length) {
    block += `\n${extraEntries.map(([key, value]) => `  <!-- ${key}: ${stringifyJsonForPrompt(value)} -->`).join("\n")}`;
  }
  return block;
}

function renderToolExampleParam(key: string, value: unknown, attrs: Record<string, unknown>): string {
  const attrText = Object.entries(attrs).map(([attr, attrValue]) => `${attr}="${String(attrValue)}"`).join(" ");
  const opening = attrText ? `<${key} ${attrText}>` : `<${key}>`;
  if (Array.isArray(value)) {
    const items = value.map((item) => `    <item>${renderExampleScalar(item)}</item>`).join("\n");
    return `  ${opening}\n${items}\n  </${key}>`;
  }
  return `  ${opening}${renderExampleScalar(value)}</${key}>`;
}

function renderExampleScalar(value: unknown): string {
  if (typeof value === "string") {
    return needsCdata(value) ? `<![CDATA[${value}]]>` : value;
  }
  return stringifyJsonForPrompt(value);
}

function needsCdata(value: string): boolean {
  return value.includes("\n") || value.includes("<") || value.includes(">") || value.includes("&");
}

function stringifyJsonForPrompt(value: unknown, indent = 0): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

function exampleValueForParam(paramName: string, rawInfo: unknown): string {
  const info = isRecord(rawInfo) ? rawInfo : {};
  const type = normalizeString(info.type);
  if (type === "boolean") {
    return "true";
  }
  if (type === "integer" || type === "number") {
    return "1";
  }
  if (type === "array") {
    return "value";
  }
  if (paramName.includes("path")) {
    return "path/to/file";
  }
  if (paramName === "command") {
    return "python script.py";
  }
  return "value";
}
