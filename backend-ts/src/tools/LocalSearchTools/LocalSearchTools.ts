import { z } from "zod";

import {
  buildTool,
  type RuntimeToolDefinition,
  type Tool,
} from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent-config.js";
import type { WorkspaceSearchPort } from "../../contracts/runtime/tool-ports.js";
import {
  readGlobArguments,
  readGrepArguments,
  readTodoWriteArguments,
  readWebFetchArguments,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from "../../services/runtime/runtime-tool-bridge/registry.js";
import { metadataFrom, optionalBoolean, optionalInteger, optionalString } from "../schema-helpers.js";

interface LocalSearchToolDeps {
  service: WorkspaceSearchPort | null;
  agent: AgentConfig;
}

const globSchema = z.object({
  pattern: z.string(),
  path: optionalString,
  recursive: optionalBoolean,
  max_results: optionalInteger,
  maxResults: optionalInteger,
}).strict();

const grepSchema = z.object({
  pattern: z.string(),
  path: optionalString,
  glob: optionalString,
  case_sensitive: optionalBoolean,
  caseSensitive: optionalBoolean,
  max_results: optionalInteger,
  maxResults: optionalInteger,
  context_lines: optionalInteger,
  contextLines: optionalInteger,
}).strict();

const webFetchSchema = z.object({
  url: z.string(),
  timeout_ms: optionalInteger,
  timeoutMs: optionalInteger,
  max_chars: optionalInteger,
  maxChars: optionalInteger,
}).strict();

const todoSchema = z.object({
  todos: z.unknown().optional(),
}).strict();

export const LOCAL_SEARCH_TOOLS: RuntimeToolDefinition[] = [
  {
    name: GLOB_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    allowed_callers: ["direct", "code_execution"],
    description: "Find files in the managed workspace using glob patterns such as **/*.ts.",
    usage_contract: [
      "查找文件优先用 glob，而非 execute_bash 的 find。",
      "Read-only operation.",
      "Limited to 250 results by default to prevent token overflow.",
      "Requires glob pattern relative to the search root.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern relative to the search root.",
        },
        path: {
          type: "string",
          description: "Optional directory relative to the managed workspace.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to recurse into subdirectories. Defaults to true when pattern contains **.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Maximum number of paths to return. Defaults to 200.",
        },
      },
    },
  },
  {
    name: GREP_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Search text in managed workspace files and return matching lines.",
    usage_contract: [
      "搜索文本优先用 grep，而非 execute_bash 的 grep/rg。",
      "Read-only operation.",
      "Automatically excludes .git, .svn, .hg, node_modules, __pycache__.",
      "Limited to 250 results by default to prevent token overflow.",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Literal text pattern to search for.",
        },
        path: {
          type: "string",
          description: "Optional directory relative to the managed workspace.",
        },
        glob: {
          type: "string",
          description: "Optional glob filter, for example **/*.ts.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether matching is case-sensitive. Defaults to false.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Maximum matches to return. Defaults to 200.",
        },
        context_lines: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          description: "Number of surrounding lines to include. Defaults to 0.",
        },
      },
    },
  },
  {
    name: WEB_FETCH_TOOL_NAME,
    source: "runtime_builtin",
    category: "network",
    riskLevel: "medium",
    allowed_callers: ["direct"],
    description: "Fetch an HTTP or HTTPS URL and return readable text content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "HTTP or HTTPS URL to fetch.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 60000,
          description: "Request timeout in milliseconds. Defaults to 15000.",
        },
        max_chars: {
          type: "integer",
          minimum: 1000,
          maximum: 200000,
          description: "Maximum returned characters. Defaults to 20000.",
        },
      },
    },
  },
  {
    name: TODO_WRITE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Replace the current session todo list with pending, in_progress, or completed items.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              active_form: { type: "string" },
            },
          },
        },
      },
    },
  },
];

export function createLocalSearchTools(deps: LocalSearchToolDeps): Tool[] {
  const service = deps.service;
  if (!service) {
    return [];
  }
  const enabled = new Set(deps.agent.tools.enabled_tools ?? []);
  const definitionByName = new Map(LOCAL_SEARCH_TOOLS.map((definition) => [definition.name, definition]));
  const tools: Tool[] = [];
  if (enabled.has(GLOB_TOOL_NAME)) {
    tools.push(
      buildTool({
        ...metadataFrom(definitionByName.get(GLOB_TOOL_NAME)!),
        inputSchema: globSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: (input, context) => service.glob(readGlobArguments(input), context),
      }),
    );
  }
  if (enabled.has(GREP_TOOL_NAME)) {
    tools.push(
      buildTool({
        ...metadataFrom(definitionByName.get(GREP_TOOL_NAME)!),
        inputSchema: grepSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        call: (input, context) => service.grep(readGrepArguments(input), context),
      }),
    );
  }
  if (enabled.has(WEB_FETCH_TOOL_NAME)) {
    tools.push(
      buildTool({
        ...metadataFrom(definitionByName.get(WEB_FETCH_TOOL_NAME)!),
        inputSchema: webFetchSchema,
        isReadOnly: () => true,
        isConcurrencySafe: () => false,
        call: (input) => service.webFetch(readWebFetchArguments(input)),
      }),
    );
  }
  if (enabled.has(TODO_WRITE_TOOL_NAME)) {
    tools.push(
      buildTool({
        ...metadataFrom(definitionByName.get(TODO_WRITE_TOOL_NAME)!),
        inputSchema: todoSchema,
        call: (input, context) => service.todoWrite(readTodoWriteArguments(input), context),
      }),
    );
  }
  return tools;
}
