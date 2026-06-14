import type { RuntimeToolDefinition } from "../runtime-tool-types.js";

export const READ_ONLY_MEMORY_TOOL_NAMES = ["list_memory_index", "read_memory_entry"] as const;
export type ReadOnlyMemoryToolName = (typeof READ_ONLY_MEMORY_TOOL_NAMES)[number];

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";
export const EDIT_FILE_TOOL_NAME = "edit_file";
export const PREVIEW_DATA_STRUCTURE_TOOL_NAME = "preview_data_structure";
export const EXECUTE_BASH_TOOL_NAME = "execute_bash";
export const EXECUTE_CODE_TOOL_NAME = "execute_code";
export const GLOB_TOOL_NAME = "glob";
export const GREP_TOOL_NAME = "grep";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const TODO_WRITE_TOOL_NAME = "todo_write";
export const CALL_AGENT_TOOL_NAME = "call_agent";
export const LIST_CHILD_AGENTS_TOOL_NAME = "list_child_agents";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const TASK_CREATE_TOOL_NAME = "task_create";
export const TASK_GET_TOOL_NAME = "task_get";
export const TASK_UPDATE_TOOL_NAME = "task_update";
export const TASK_LIST_TOOL_NAME = "task_list";
export const TASK_OUTPUT_TOOL_NAME = "task_output";
export const TASK_STOP_TOOL_NAME = "task_stop";
export const WRITE_MEMORY_TOOL_NAME = "write_memory";
export const ARCHIVE_MEMORY_TOOL_NAME = "archive_memory";
export const SEARCH_KNOWLEDGE_BASE_TOOL_NAME = "search_knowledge_base";
export const LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME = "list_knowledge_collections";
export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";
export const LOAD_SKILL_RESOURCE_TOOL_NAME = "load_skill_resource";
export const EXECUTE_SKILL_SCRIPT_TOOL_NAME = "execute_skill_script";
export const GET_SKILL_INFO_TOOL_NAME = "get_skill_info";

export const REQUEST_USER_INPUT_TOOL: RuntimeToolDefinition = {
  name: REQUEST_USER_INPUT_TOOL_NAME,
  source: "runtime_builtin",
  category: "interaction",
  riskLevel: "low",
  approvalExempt: true,
  description:
    "Ask the user for missing information that is required to continue. Use only when the answer cannot be inferred or obtained with available tools.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "Question shown to the user. Be specific about the missing information.",
      },
      input_type: {
        type: "string",
        enum: ["text", "select"],
        description: "Use text for free-form input, select when options are provided.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Options for select input_type.",
      },
    },
  },
};

export const DOCUMENT_TOOLS: RuntimeToolDefinition[] = [
  {
    name: READ_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Read a managed workspace/session file by line range. Defaults to line 1 and at most 2000 lines. Use offset/limit for large files.",
    returns: {
      description: "成功时返回文件内容和分页元数据。",
      shape: {
        content: "string",
        metadata: {
          file_path: "string",
          file_size: "number",
          total_lines: "number",
          start_line: "number",
          end_line: "number",
          has_more: "boolean",
          next_offset: "number|null",
        },
      },
    },
    usage_contract: [
      "read_file 默认只返回前 2000 行；大文件请用 metadata.next_offset 继续分页。",
      "可用 offset/limit 指定行号区间。",
      "返回内容为文件原始文本内容，不附带行号。",
      "file_path 必须是真实路径字符串，不是变量名文本。",
      "数据文件已有路径时，优先用 preview_data_structure 确认结构。",
    ],
    examples: [
      {
        input: { file_path: "tmp.txt" },
        xml_attrs: { file_path: { space: "transient" } },
        result_hint: { content: "temporary text" },
      },
      {
        input: { file_path: "./data/large.txt", offset: 100, limit: 50 },
        result_hint: {
          content: "line 100 ...",
          metadata: { start_line: 100, end_line: 149, has_more: true, next_offset: 150 },
        },
      },
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: {
          type: "string",
          description: "File path. Relative paths resolve against the current workspace first, then session managed directories.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line number. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum lines to read. Defaults to 2000.",
        },
      },
    },
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "high",
    allowed_callers: ["direct"],
    description:
      "Write text or JSON content to a managed workspace/session file. If file_path is omitted, the runtime allocates a managed output path.",
    returns: {
      description: "成功时返回保存后的文件信息。",
      shape: {
        file_path: "string",
        file_size: "number",
        display_path: "string",
      },
    },
    usage_contract: [
      "content 是最终要写入的文本；JSON 请先序列化成字符串。",
      "后续工具需要路径时，优先复用返回的 file_path。",
      "若在同一轮链式调用，可引用 {result_N.content.file_path}。",
      "修改已有文件的部分内容时，请优先使用 edit_file。",
    ],
    examples: [
      {
        input: { content: "temporary text", file_path: "tmp.txt" },
        xml_attrs: { file_path: { space: "transient" } },
        result_hint: { display_path: "./data/sessions/<session_id>/transient/tmp.txt" },
      },
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          description: "Content to write. Strings are written as text; objects are serialized when mode=json.",
        },
        file_path: {
          type: "string",
          description: "Optional file path. Relative paths resolve to managed workspace/session roots.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        mode: {
          type: "string",
          enum: ["text", "json"],
          description: "Write mode. Defaults to text.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
      },
    },
  },
  {
    name: EDIT_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "high",
    allowed_callers: ["direct"],
    description:
      "Edit a managed file by exact string replacement. old_string must match uniquely unless replace_all=true.",
    returns: {
      description: "成功时返回编辑后的文件信息。",
      shape: {
        file_path: "string",
        replacements: "number",
        display_path: "string",
      },
    },
    usage_contract: [
      "old_string 必须与文件内容精确匹配，包含空白和换行。",
      "默认要求唯一匹配；需要批量替换时显式传 replace_all=true。",
      "编辑已有文件优先使用 edit_file，不要用 write_file 重写整文件。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: {
          type: "string",
          description: "File path to edit. Relative paths resolve to managed workspace/session roots.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace. Must include whitespace/newlines exactly.",
        },
        new_string: {
          type: "string",
          description: "Replacement text. Empty string deletes old_string.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all matches instead of requiring a unique match.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
      },
    },
  },
  {
    name: PREVIEW_DATA_STRUCTURE_TOOL_NAME,
    source: "document",
    category: "data",
    riskLevel: "low",
    allowed_callers: ["direct", "code_execution"],
    description:
      "Preview the data structure of a managed JSON, YAML, CSV, TSV, or text file without returning the full file content.",
    returns: {
      description: "成功时返回文件类型、基础元信息和结构预览结果。",
      shape: {
        content: {
          file_path: "string",
          file_name: "string",
          file_type: "string",
          file_size: "number",
          structure: "object",
        },
        metadata: {
          file_type: "string",
          file_size: "number",
          max_preview_rows: "number",
          max_depth: "number",
          max_fields: "number",
        },
      },
    },
    usage_contract: [
      "适合先探索数据结构，再决定是否调用 read_file 或直接进入后续处理步骤。",
      "JSON/YAML 返回层级结构预览；CSV/TSV 返回列与样例行；文本返回行统计与预览。",
      "想看更深层结构时可提高 max_depth；想看更多列或样例可提高 max_fields/max_preview_rows。",
    ],
    examples: [
      {
        input: { file_path: "./data/sample.json", max_depth: 2 },
        result_hint: { file_type: "json", structure: { type: "object" } },
      },
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: {
          type: "string",
          description: "File path to preview. Relative paths resolve against managed workspace/session roots.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
        max_preview_rows: {
          type: "integer",
          minimum: 1,
          description: "Maximum sampled table rows, text lines, or array items. Defaults to 5.",
        },
        max_depth: {
          type: "integer",
          minimum: 1,
          description: "Maximum nested structure depth for JSON/YAML. Defaults to 3.",
        },
        max_fields: {
          type: "integer",
          minimum: 1,
          description: "Maximum object fields or table columns to summarize. Defaults to 20.",
        },
      },
    },
  },
];

export const EXECUTE_BASH_TOOL: RuntimeToolDefinition = {
  name: EXECUTE_BASH_TOOL_NAME,
  source: "execution",
  category: "execution",
  riskLevel: "high",
  allowed_callers: ["direct"],
  description:
    "Execute a shell command in a managed workspace directory. Read-only commands run directly; write, unknown, network, destructive, and interpreter commands may require approval.",
  extended_usage: `### 工作目录说明

三个受管目录空间：\`workspace\`（默认）、\`transient\`（临时）、\`exports\`（导出）。

- 相对路径：默认按 \`workspace\` 解析
- 绝对路径：必须在受管目录内
- 指定空间：使用 \`working_dir_space\` 参数`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute. Command substitution, hidden newlines, dangerous env overrides, and write redirection are blocked.",
      },
      working_dir: {
        type: "string",
        description: "Optional working directory. Relative paths resolve against the selected managed space, defaulting to workspace.",
      },
      working_dir_space: {
        type: "string",
        enum: ["workspace", "transient", "exports"],
        description: "Managed directory space for working_dir.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 600,
        description: "Timeout in seconds. Defaults to 120 and is capped at 600.",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the command in the background and immediately return a background_task_id.",
      },
      description: {
        type: "string",
        description: "Short purpose shown in approval prompts and execution logs.",
      },
    },
  },
};

export const EXECUTE_CODE_TOOL: RuntimeToolDefinition = {
  name: EXECUTE_CODE_TOOL_NAME,
  source: "execution",
  category: "execution",
  riskLevel: "high",
  allowed_callers: ["direct"],
  description:
    "Execute Python code in a restricted sandbox for data processing and limited tool orchestration. Set result as the final output.",
  extended_usage: `### 模块与全局变量

- \`result\` — 必须赋值为最终输出
- \`call_tool(tool_name, arguments)\` — 调用其他工具（仅限 \`allowed_callers\` 包含 \`code_execution\` 的工具）

只在需要程序化处理、批量转换或有限工具编排时使用 execute_code。`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["code"],
    properties: {
      code: {
        type: "string",
        description: "Python code. Must assign the final output to the result variable.",
      },
      description: {
        type: "string",
        description: "Short purpose of the code execution.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 300,
        description: "Timeout in seconds. Defaults to 60 and is capped at 300.",
      },
    },
  },
};

export const LOCAL_SEARCH_TOOLS: RuntimeToolDefinition[] = [
  {
    name: GLOB_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    allowed_callers: ["direct", "code_execution"],
    description: "Find files in the managed workspace using glob patterns such as **/*.ts.",
    usage_contract: [
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

export const KNOWLEDGE_TOOLS: RuntimeToolDefinition[] = [
  {
    name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
    source: "knowledge",
    category: "knowledge",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Search the enabled Agent knowledge base for document chunks relevant to a query. Uses Agent knowledge_base defaults when optional fields are omitted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query text.",
        },
        collection: {
          type: "string",
          description: "Knowledge collection name. Defaults to the Agent knowledge_base default_collection.",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          description: "Maximum result count. Defaults to the Agent knowledge_base default_top_k.",
        },
        search_mode: {
          type: "string",
          enum: ["vector", "hybrid"],
          description: "Search mode. Defaults to the Agent knowledge_base default_search_mode.",
        },
        rerank: {
          type: "boolean",
          description: "Whether to rerank hybrid results. Defaults to the Agent knowledge_base default_rerank.",
        },
        filters: {
          type: "object",
          description: "Optional metadata filters reserved for vector-store compatible callers.",
        },
      },
    },
  },
  {
    name: LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
    source: "knowledge",
    category: "knowledge",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List available knowledge base collections and their document/chunk counts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

export const SKILL_TOOLS: RuntimeToolDefinition[] = [
  {
    name: ACTIVATE_SKILL_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Activate a Skill and return its SKILL.md main instructions.",
    returns: {
      description: "成功时返回 Skill 主文件内容和基础信息。",
      shape: {
        skill_name: "string",
        description: "string",
        main_content: "string",
      },
    },
    usage_contract: [
      "activate_skill 通常是使用 Skill 的第一步。",
      "返回的 main_content 就是 SKILL.md 正文，可直接按其中流程继续执行。",
      "若主文件提到额外资源，再调用 load_skill_resource。",
      "若主文件要求执行脚本，再调用 execute_skill_script。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: LOAD_SKILL_RESOURCE_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Load an additional resource file from an activated Skill.",
    returns: {
      description: "成功时返回指定资源文件的内容。",
      shape: {
        file_name: "string",
        content: "string",
        skill: "string",
      },
    },
    usage_contract: [
      "load_skill_resource 用于加载 activate_skill 主文件里提到的补充文档。",
      "resource_file 应使用主文件中出现的相对文件名。",
      "加载后的 content 可直接作为后续执行依据。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "resource_file"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        resource_file: { type: "string", description: "Relative resource file name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: EXECUTE_SKILL_SCRIPT_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "medium",
    allowed_callers: ["direct"],
    description:
      "Execute a Skill utility script. The arguments field is argv-style: each command-line token must be one array item.",
    usage_contract: [
      "arguments 是 argv token 数组，不要合并成单个字符串。",
      "XML 调用时 arguments 必须用 <item> 表示每个 token。",
      "不要使用 <arg>，不要把多个参数合并成一个字符串或 JSON 对象。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "script_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        script_name: { type: "string", description: "Script file name under the Skill scripts directory." },
        arguments: {
          type: "array",
          items: { type: "string" },
          description:
            "Command line argv tokens. XML calls must use <item> children, one token per item, such as <item>--data</item><item>data.json</item>. Do not use <arg>, do not join tokens with spaces/semicolons, and do not pass an object like {\"--data\":\"...\"}.",
        },
        run_in_background: { type: "boolean", description: "Reserved for background execution." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: GET_SKILL_INFO_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Get lightweight Skill metadata without loading full instructions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
];

export const READ_ONLY_MEMORY_TOOLS: RuntimeToolDefinition[] = [
  {
    name: "list_memory_index",
    source: "memory",
    category: "memory",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List the MEMORY.md index for an allowed memory scope before selecting an entry file to read.",
    returns: {
      description: "返回 MEMORY.md 索引头部和索引文件路径。",
      shape: {
        content: "string",
        metadata: {
          scope: "string",
          index_file_path: "string",
        },
      },
    },
    usage_contract: [
      "先调用 list_memory_index 再决定是否读取具体记忆文件。",
      "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
      "该工具只返回 MEMORY.md 头部，不返回所有记忆正文。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace"],
          description: "Memory scope to inspect.",
        },
        session_id: {
          type: "string",
          description: "Optional session id. Omit it when the current session context should be used.",
        },
        agent_name: {
          type: "string",
          description: "Optional agent name for agent-scoped memory.",
        },
        workspace_key: {
          type: "string",
          description: "Optional normalized workspace memory key.",
        },
        team_name: {
          type: "string",
          description: "Optional team name for team-scoped or agent-scoped memory.",
        },
        workspace_root: {
          type: "string",
          description: "Optional workspace root path used to derive workspace memory.",
        },
      },
    },
  },
  {
    name: "read_memory_entry",
    source: "memory",
    category: "memory",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Read one memory entry file from an allowed memory scope after checking the index.",
    returns: {
      description: "返回单条记忆正文和文件路径。",
      shape: {
        content: "string",
        metadata: {
          file_path: "string",
          scope: "string",
        },
      },
    },
    usage_contract: [
      "通常先通过 list_memory_index 或 prompt 中给出的 memory 文件路径定位 file_name，再调用本工具。",
      "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
      "该工具只读取一条具体记忆，不做全文检索。",
    ],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "file_name"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace"],
          description: "Memory scope containing the entry file.",
        },
        file_name: {
          type: "string",
          description: "Memory entry file name from the index, for example fact_alpha.md.",
        },
        session_id: {
          type: "string",
          description: "Optional session id. Omit it when the current session context should be used.",
        },
        agent_name: {
          type: "string",
          description: "Optional agent name for agent-scoped memory.",
        },
        workspace_key: {
          type: "string",
          description: "Optional normalized workspace memory key.",
        },
        team_name: {
          type: "string",
          description: "Optional team name for team-scoped or agent-scoped memory.",
        },
        workspace_root: {
          type: "string",
          description: "Optional workspace root path used to derive workspace memory.",
        },
      },
    },
  },
];

export const WRITE_MEMORY_TOOL: RuntimeToolDefinition = {
  name: WRITE_MEMORY_TOOL_NAME,
  source: "memory",
  category: "memory",
  riskLevel: "low",
  allowed_callers: ["direct"],
  description: "Create or update one memory entry in an allowed writable scope and rebuild that scope's MEMORY.md index.",
  returns: {
    description: "返回写入后的记忆文件路径和摘要。",
    shape: {
      content: "string",
      metadata: {
        file_path: "string",
        scope: "string",
      },
    },
  },
  usage_contract: [
    "写入记忆前应确保 scope 允许写入。",
    "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
    "后续如需查看结果，优先复用返回的 file_path。",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "name", "description", "memory_type", "content"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace"],
        description: "Memory scope to write.",
      },
      name: {
        type: "string",
        description: "Memory name.",
      },
      description: {
        type: "string",
        description: "Short memory summary used in MEMORY.md.",
      },
      memory_type: {
        type: "string",
        enum: ["preference", "constraint", "goal", "fact", "profile"],
        description: "Memory type.",
      },
      content: {
        type: "string",
        description: "Memory body.",
      },
      why: {
        type: "string",
        description: "Optional Why section.",
      },
      how_to_apply: {
        type: "string",
        description: "Optional How to apply section.",
      },
      source_run_id: {
        type: "string",
        description: "Optional source run id.",
      },
      source_message_id: {
        type: "string",
        description: "Optional source message id.",
      },
      session_id: {
        type: "string",
        description: "Optional session id. Omit it when the current session context should be used.",
      },
      agent_name: {
        type: "string",
        description: "Optional agent name for agent-scoped memory.",
      },
      workspace_key: {
        type: "string",
        description: "Optional normalized workspace memory key.",
      },
      team_name: {
        type: "string",
        description: "Optional team name for team-scoped or agent-scoped memory.",
      },
      workspace_root: {
        type: "string",
        description: "Optional workspace root path used to derive workspace memory.",
      },
    },
  },
};

export const ARCHIVE_MEMORY_TOOL: RuntimeToolDefinition = {
  name: ARCHIVE_MEMORY_TOOL_NAME,
  source: "memory",
  category: "memory",
  riskLevel: "low",
  allowed_callers: ["direct"],
  description: "Archive one memory entry in an allowed archive scope and rebuild that scope's MEMORY.md index.",
  returns: {
    description: "返回归档后的记忆文件路径和状态。",
    shape: {
      content: "string",
      metadata: {
        file_path: "string",
        scope: "string",
      },
    },
  },
  usage_contract: [
    "归档前应确保 scope 允许归档。",
    "team、session、agent、workspace 等定位信息由运行时上下文自动注入，Agent 不应手工构造。",
    "该工具只处理单条记忆，不做批量操作。",
  ],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "file_name"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace"],
        description: "Memory scope containing the entry file.",
      },
      file_name: {
        type: "string",
        description: "Memory entry file name to archive.",
      },
      session_id: {
        type: "string",
        description: "Optional session id. Omit it when the current session context should be used.",
      },
      agent_name: {
        type: "string",
        description: "Optional agent name for agent-scoped memory.",
      },
      workspace_key: {
        type: "string",
        description: "Optional normalized workspace memory key.",
      },
      team_name: {
        type: "string",
        description: "Optional team name for team-scoped or agent-scoped memory.",
      },
      workspace_root: {
        type: "string",
        description: "Optional workspace root path used to derive workspace memory.",
      },
    },
  },
};

export const TASK_WORKFLOW_TOOLS: RuntimeToolDefinition[] = [
  {
    name: TASK_CREATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Create a session-scoped task record for multi-step work tracking.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "description"],
      properties: {
        subject: { type: "string", description: "Short task title." },
        description: { type: "string", description: "Detailed task description and acceptance criteria." },
        active_form: { type: "string", description: "Display text while the task is in progress." },
        metadata: { type: "object", description: "Optional metadata." },
      },
    },
  },
  {
    name: TASK_GET_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Read a session-scoped task by id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task id returned by task_create." },
      },
    },
  },
  {
    name: TASK_UPDATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Update task fields, status, dependency links, or metadata.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        active_form: { type: "string" },
        owner: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        add_blocks: { type: "array", items: { type: "string" } },
        add_blocked_by: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: TASK_LIST_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List session-scoped task summaries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

export const TASK_OUTPUT_TOOL: RuntimeToolDefinition = {
  name: TASK_OUTPUT_TOOL_NAME,
  source: "runtime_builtin",
  category: "task",
  riskLevel: "low",
  allowed_callers: ["direct"],
  description: "Read a background task status and output, optionally requesting an explicit wait.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task_id"],
    properties: {
      task_id: { type: "string", description: "Background task id." },
      block: { type: "boolean", description: "Whether to request waiting for completion." },
      timeout: { type: "integer", minimum: 0, maximum: 600000, description: "Wait timeout in milliseconds." },
      max_chars: { type: "integer", minimum: 200, description: "Maximum output characters to read." },
    },
  },
};

export const TASK_STOP_TOOL: RuntimeToolDefinition = {
  name: TASK_STOP_TOOL_NAME,
  source: "runtime_builtin",
  category: "task",
  riskLevel: "medium",
  allowed_callers: ["direct"],
  description: "Stop a cancellable background task.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task_id"],
    properties: {
      task_id: { type: "string", description: "Background task id." },
    },
  },
};

export const AGENT_DELEGATION_TOOLS: RuntimeToolDefinition[] = [
  {
    name: CALL_AGENT_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description:
      "Delegate a self-contained subtask to one allowed child Agent. agent_name must come from the current Agent delegation allowlist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["agent_name", "task"],
      properties: {
        agent_name: {
          type: "string",
          description: "Target child Agent name from the current delegation allowlist.",
        },
        task: {
          type: "string",
          description: "Complete task description with all context the child Agent needs.",
        },
        context_hint: {
          type: "string",
          description: "Optional extra constraints, output format, or background.",
        },
      },
    },
  },
  {
    name: LIST_CHILD_AGENTS_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "List existing child Agent sessions in the current session so a prior child_agent_id can be reused.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agent_name: {
          type: "string",
          description: "Optional Agent name filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of child Agents to return. Defaults to 20.",
        },
      },
    },
  },
  {
    name: SEND_MESSAGE_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    allowed_callers: ["direct"],
    description: "Send a follow-up message to an existing child Agent session by child_agent_id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["child_agent_id", "message"],
      properties: {
        child_agent_id: {
          type: "string",
          description: "Child Agent id returned by call_agent or list_child_agents.",
        },
        message: {
          type: "string",
          description: "Follow-up task or correction for the existing child Agent.",
        },
      },
    },
  },
];
