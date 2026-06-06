type BackendName = "python" | "ts";
type ExecutionProfile = "minimal" | "core" | "full";

interface Backend {
  name: BackendName;
  baseUrl: string;
}

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface HttpResult {
  status: number;
  contentType: string;
  json: unknown | null;
  text: string;
}

interface Options {
  pythonBaseUrl: string;
  tsBaseUrl: string;
  sessionId: string | null;
  selectedLlm: string | null;
  includeExecution: boolean;
  executionTask: string;
  customExecutionTask: boolean;
  executionProfile: ExecutionProfile;
  executionTimeoutMs: number;
  pollIntervalMs: number;
}

interface PermissionPolicy {
  mode?: string;
  auto_accept_patterns?: unknown[];
  audit_all_checks?: boolean;
  approval_timeout?: number;
  skip_all_approvals?: boolean;
}

interface ExecutionScenario {
  name: string;
  task: string;
  requiredTools: string[];
}

interface ExecutionRunResult {
  sessionId: string;
  completed: boolean;
  detail: string;
  messagesStatus: number;
  hasUser: boolean;
  assistant: Record<string, unknown> | null;
  runStepsStatus: number | null;
  runSteps: Record<string, unknown>[];
  toolNames: string[];
}

const CORE_TOOL_NAMES = [
  "request_user_input",
  "read_file",
  "write_file",
  "edit_file",
  "preview_data_structure",
  "execute_bash",
  "task_create",
  "task_get",
  "task_update",
  "task_list",
  "task_stop",
  "list_memory_index",
  "read_memory_entry",
  "call_agent",
  "list_child_agents",
  "send_message",
];

const PROMPT_NEEDLES = [
  ["ragsystem", "You are RAGSystem"],
  ["base-agent-prompt", "\u7cfb\u7edf\u9ed8\u8ba4\u4e3b\u7f16\u6392\u5668"],
  ["direct-tools", "## \u53ef\u76f4\u63a5\u8c03\u7528\u7684\u5de5\u5177"],
  ["execute-bash", "execute_bash"],
  ["task-tools", "task_create"],
  ["delegation", "## \u5b50 Agent \u59d4\u6d3e"],
  ["output-format", "## \u8f93\u51fa\u683c\u5f0f"],
  ["execution-rules", "## \u6267\u884c\u89c4\u5219"],
  ["data-file-rules", "### \u6570\u636e\u6587\u4ef6\u4f20\u9012\u89c4\u5219"],
] as const;

const DEFAULT_EXECUTION_TASK = "Reply exactly: parity-smoke-ok";
const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = "core";

const MINIMAL_EXECUTION_SCENARIO: ExecutionScenario = {
  name: "minimal",
  task: DEFAULT_EXECUTION_TASK,
  requiredTools: [],
};

const CORE_EXECUTION_SCENARIOS: ExecutionScenario[] = [
  MINIMAL_EXECUTION_SCENARIO,
  {
    name: "file-chain",
    requiredTools: ["write_file", "read_file", "edit_file"],
    task: [
      "Live parity smoke: file tool chain.",
      "You must call tools instead of answering directly.",
      "In one tool_calls/tools block when possible, do:",
      "1. write_file with file_path 'parity-smoke-file.txt' and content 'alpha\\nbeta\\n'.",
      "2. read_file with file_path {result_1.content.file_path}.",
      "3. edit_file with file_path {result_1.content.file_path}, old_string 'beta', new_string 'gamma'.",
      "4. read_file again with file_path {result_1.content.file_path}.",
      "After tools finish, final answer exactly: parity-file-ok",
    ].join("\n"),
  },
  {
    name: "preview-chain",
    requiredTools: ["write_file", "preview_data_structure"],
    task: [
      "Live parity smoke: data preview chain.",
      "You must call tools instead of answering directly.",
      "1. write_file with file_path 'parity-smoke-preview.json', mode 'json', and content '{\"items\":[{\"name\":\"alpha\",\"value\":1}]}'.",
      "2. preview_data_structure with file_path {result_1.content.file_path}.",
      "After tools finish, final answer exactly: parity-preview-ok",
    ].join("\n"),
  },
  {
    name: "bash-foreground",
    requiredTools: ["execute_bash"],
    task: [
      "Live parity smoke: foreground bash.",
      "You must call execute_bash with command 'echo parity-bash-ok'.",
      "After the tool finishes, final answer exactly: parity-bash-ok",
    ].join("\n"),
  },
  {
    name: "bash-background",
    requiredTools: ["execute_bash"],
    task: [
      "Live parity smoke: background bash.",
      "You must call execute_bash with command 'echo parity-bg-ok', run_in_background true, timeout 30, and description 'parity background smoke'.",
      "After the tool starts, final answer exactly: parity-bg-ok",
    ].join("\n"),
  },
  {
    name: "task-crud",
    requiredTools: ["task_create", "task_get", "task_update"],
    task: [
      "Live parity smoke: task CRUD chain.",
      "You must call tools instead of answering directly.",
      "1. task_create with subject 'Parity smoke task' and description 'Verify task tool semantics'.",
      "2. task_get with task_id {result_1.content.task.id}.",
      "3. task_update with task_id {result_1.content.task.id} and status 'completed'.",
      "After tools finish, final answer exactly: parity-task-ok",
    ].join("\n"),
  },
  {
    name: "task-list",
    requiredTools: ["task_list"],
    task: [
      "Live parity smoke: task list.",
      "You must call task_list exactly once instead of answering directly.",
      "After the tool finishes, final answer exactly: parity-task-list-ok",
    ].join("\n"),
  },
];

const FULL_EXECUTION_SCENARIOS: ExecutionScenario[] = [
  ...CORE_EXECUTION_SCENARIOS,
  {
    name: "delegation",
    requiredTools: ["call_agent", "list_child_agents"],
    task: [
      "Live parity smoke: child agent delegation.",
      "You must call tools instead of answering directly.",
      "1. call_agent with agent_name 'general_agent', task 'Reply exactly: parity-child-ok', and context_hint 'No tools are needed; answer directly.'.",
      "2. list_child_agents with agent_name 'general_agent'.",
      "After tools finish, final answer exactly: parity-agent-ok",
    ].join("\n"),
  },
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const python: Backend = { name: "python", baseUrl: normalizeBaseUrl(options.pythonBaseUrl) };
  const ts: Backend = { name: "ts", baseUrl: normalizeBaseUrl(options.tsBaseUrl) };
  const results: CheckResult[] = [];

  results.push(...await checkHealth([python, ts]));
  results.push(...await checkRuntimeCoreStatus(python, ts));
  const snapshotResults = await checkContextSnapshot(python, ts, options);
  results.push(...snapshotResults.results);
  if (options.sessionId) {
    results.push(...await checkTaskStatusShape([python, ts], options.sessionId));
  }
  if (options.includeExecution) {
    results.push(...await checkExecutionSmoke([python, ts], options));
  }

  printReport(results, snapshotResults.summary);
  if (results.some((result) => result.status === "fail")) {
    process.exitCode = 1;
  }
}

async function checkHealth(backends: Backend[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const backend of backends) {
    const response = await request(backend, "/api/agent/health");
    const data = getResponseData(response.json);
    const status = getPath(data, ["status"]);
    results.push({
      name: `${backend.name}:agent-health`,
      status: response.status === 200 && status === "healthy" ? "pass" : "fail",
      detail: `status=${response.status} health=${String(status)}`,
    });
  }
  return results;
}

async function checkRuntimeCoreStatus(python: Backend, ts: Backend): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const tsResponse = await request(ts, "/api/agent/runtime-core/status");
  const tsData = getResponseData(tsResponse.json);
  const ready = getPath(tsData, ["configuration_ready"]);
  const canExecute = getPath(tsData, ["can_execute"]);
  results.push({
    name: "ts:runtime-core-ready",
    status: tsResponse.status === 200 && ready === true && canExecute === true ? "pass" : "fail",
    detail: `status=${tsResponse.status} configuration_ready=${String(ready)} can_execute=${String(canExecute)}`,
  });

  const pythonResponse = await request(python, "/api/agent/runtime-core/status", { tolerateNonJson: true });
  const pythonData = getResponseData(pythonResponse.json);
  const pythonReady = getPath(pythonData, ["configuration_ready"]);
  results.push({
    name: "python:runtime-core-route",
    status: pythonReady === undefined ? "warn" : "pass",
    detail: pythonReady === undefined
      ? "Python has no runtime-core/status JSON route; skipped as expected."
      : `configuration_ready=${String(pythonReady)}`,
  });
  return results;
}

async function checkContextSnapshot(
  python: Backend,
  ts: Backend,
  options: Options,
): Promise<{ results: CheckResult[]; summary: Record<string, unknown> }> {
  const pythonSnapshot = await fetchSnapshot(python, options);
  const tsSnapshot = await fetchSnapshot(ts, options);
  const results: CheckResult[] = [
    checkSnapshotShape("python", pythonSnapshot),
    checkSnapshotShape("ts", tsSnapshot),
    ...checkPromptNeedles("python", pythonSnapshot),
    ...checkPromptNeedles("ts", tsSnapshot),
    ...checkCoreToolCoverage("python", pythonSnapshot),
    ...checkCoreToolCoverage("ts", tsSnapshot),
    checkSetParity({
      name: "delegated-agent-roster",
      leftLabel: "python",
      rightLabel: "ts",
      left: getNames(pythonSnapshot, "available_agent_tools"),
      right: getNames(tsSnapshot, "available_agent_tools"),
      strict: true,
    }),
    checkSetParity({
      name: "skill-summary",
      leftLabel: "python",
      rightLabel: "ts",
      left: getNames(pythonSnapshot, "available_skills"),
      right: getNames(tsSnapshot, "available_skills"),
      strict: true,
    }),
  ];

  const pythonTools = getNames(pythonSnapshot, "available_tools");
  const tsTools = getNames(tsSnapshot, "available_tools");
  const pythonOnly = difference(pythonTools, tsTools);
  const tsOnly = difference(tsTools, pythonTools);
  results.push({
    name: "tool-list-delta",
    status: pythonOnly.length || tsOnly.length ? "warn" : "pass",
    detail: `python_only=[${pythonOnly.join(", ")}] ts_only=[${tsOnly.join(", ")}]`,
  });

  return {
    results,
    summary: {
      python_prompt_length: getSystemPrompt(pythonSnapshot).length,
      ts_prompt_length: getSystemPrompt(tsSnapshot).length,
      python_tools: pythonTools.length,
      ts_tools: tsTools.length,
      python_delegated_agents: getNames(pythonSnapshot, "available_agent_tools").length,
      ts_delegated_agents: getNames(tsSnapshot, "available_agent_tools").length,
    },
  };
}

async function checkTaskStatusShape(backends: Backend[], sessionId: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const backend of backends) {
    const response = await request(backend, `/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
    const data = getResponseData(response.json);
    const hasRequiredShape =
      response.status === 200 &&
      typeof getPath(data, ["session_id"]) === "string" &&
      typeof getPath(data, ["has_running_task"]) === "boolean" &&
      typeof getPath(data, ["has_active_system_command"]) === "boolean";
    results.push({
      name: `${backend.name}:task-status-shape`,
      status: hasRequiredShape ? "pass" : "fail",
      detail: `status=${response.status} session_id=${String(getPath(data, ["session_id"]))}`,
    });
  }
  return results;
}

async function checkExecutionSmoke(backends: Backend[], options: Options): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const scenarios = getExecutionScenarios(options);
  for (const backend of backends) {
    const originalPolicy = await getPermissionPolicy(backend);
    try {
      results.push(await setExecutionPermissionPolicy(backend, originalPolicy));
      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        const run = await runExecutionScenario(backend, options, scenario, stamp, scenarioIndex + 1);
        results.push(...buildExecutionScenarioResults(backend, scenario, run));
      }
    } finally {
      if (originalPolicy) {
        results.push(await restorePermissionPolicy(backend, originalPolicy));
      }
    }
  }
  return results;
}

async function runExecutionScenario(
  backend: Backend,
  options: Options,
  scenario: ExecutionScenario,
  stamp: string,
  scenarioIndex: number,
): Promise<ExecutionRunResult> {
  const sessionId = `parity-smoke-${backend.name}-${stamp}-${scenarioIndex}-${scenario.name}`;
  const body: Record<string, unknown> = {
    task: scenario.task,
    session_id: sessionId,
    attachments: [],
  };
  if (options.selectedLlm) {
    body.selected_llm = options.selectedLlm;
  }
  const start = await request(backend, "/api/agent/stream", {
    method: "POST",
    body,
    headers: { "x-request-id": `parity-smoke-${backend.name}-${stamp}-${scenario.name}` },
  });
  const startData = getResponseData(start.json);
  const started = getPath(startData, ["started"]);
  if (start.status !== 200 || started !== true) {
    return {
      sessionId,
      completed: false,
      detail: `start status=${start.status} started=${String(started)}`,
      messagesStatus: 0,
      hasUser: false,
      assistant: null,
      runStepsStatus: null,
      runSteps: [],
      toolNames: [],
    };
  }

  const finalStatus = await waitForExecution(backend, sessionId, options);
  const executionData = await fetchExecutionMessagesAndSteps(backend, sessionId);
  return {
    sessionId,
    completed: finalStatus.completed,
    detail: finalStatus.detail,
    ...executionData,
  };
}

async function fetchExecutionMessagesAndSteps(
  backend: Backend,
  sessionId: string,
): Promise<Omit<ExecutionRunResult, "sessionId" | "completed" | "detail">> {
  const messages = await request(backend, `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=50&offset=0`);
  const items = getMessageItems(getResponseData(messages.json));
  const hasUser = items.some((item) => getPath(item, ["role"]) === "user");
  const assistants = items.filter((item) => getPath(item, ["role"]) === "assistant" && String(getPath(item, ["content"]) ?? "").trim());
  const assistant = assistants.at(-1) ?? null;
  if (!assistant) {
    return {
      messagesStatus: messages.status,
      hasUser,
      assistant: null,
      runStepsStatus: null,
      runSteps: [],
      toolNames: [],
    };
  }

  const messageId = String(getPath(assistant, ["id"]) ?? "");
  const runStepsResponse = messageId
    ? await request(backend, `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/run-steps?limit=200&offset=0`)
    : null;
  const runStepsData = runStepsResponse ? getResponseData(runStepsResponse.json) : null;
  const runSteps = getRunStepItems(runStepsData);
  return {
    messagesStatus: messages.status,
    hasUser,
    assistant,
    runStepsStatus: runStepsResponse?.status ?? null,
    runSteps,
    toolNames: getToolNamesFromRunSteps(runSteps),
  };
}

function buildExecutionScenarioResults(
  backend: Backend,
  scenario: ExecutionScenario,
  run: ExecutionRunResult,
): CheckResult[] {
  const scenarioPrefix = `${backend.name}:execution:${scenario.name}`;
  const results: CheckResult[] = [
    {
      name: `${scenarioPrefix}:complete`,
      status: run.completed ? "pass" : "fail",
      detail: `${run.detail} session_id=${run.sessionId}`,
    },
    {
      name: `${scenarioPrefix}:messages`,
      status: run.messagesStatus === 200 && run.hasUser && run.assistant !== null ? "pass" : "fail",
      detail: `status=${run.messagesStatus} user=${String(run.hasUser)} assistant=${String(run.assistant !== null)}`,
    },
  ];
  if (scenario.requiredTools.length > 0) {
    const missingTools = scenario.requiredTools.filter((toolName) => !run.toolNames.includes(toolName));
    results.push({
      name: `${scenarioPrefix}:tools`,
      status: run.runStepsStatus === 200 && missingTools.length === 0 ? "pass" : "fail",
      detail: `run_steps_status=${String(run.runStepsStatus)} tools=[${run.toolNames.join(", ")}] missing=[${missingTools.join(", ")}]`,
    });
  }
  return results;
}

function getExecutionScenarios(options: Options): ExecutionScenario[] {
  if (options.customExecutionTask) {
    return [
      {
        name: "custom",
        task: options.executionTask,
        requiredTools: [],
      },
    ];
  }
  if (options.executionProfile === "minimal") {
    return [MINIMAL_EXECUTION_SCENARIO];
  }
  if (options.executionProfile === "full") {
    return FULL_EXECUTION_SCENARIOS;
  }
  return CORE_EXECUTION_SCENARIOS;
}

async function getPermissionPolicy(backend: Backend): Promise<PermissionPolicy | null> {
  const response = await request(backend, "/api/permissions/policy");
  if (response.status !== 200 || !isRecord(response.json)) {
    return null;
  }
  const data = getResponseData(response.json);
  return isRecord(data) ? data as PermissionPolicy : response.json as PermissionPolicy;
}

async function setExecutionPermissionPolicy(backend: Backend, originalPolicy: PermissionPolicy | null): Promise<CheckResult> {
  if (!originalPolicy) {
    return {
      name: `${backend.name}:execution-permission-policy`,
      status: "warn",
      detail: "Could not read original permission policy; execution approvals may block.",
    };
  }
  const policy: PermissionPolicy = {
    mode: "dangerously_skip_permissions",
    auto_accept_patterns: Array.isArray(originalPolicy.auto_accept_patterns) ? originalPolicy.auto_accept_patterns : [],
    audit_all_checks: Boolean(originalPolicy.audit_all_checks),
    approval_timeout: typeof originalPolicy.approval_timeout === "number" ? originalPolicy.approval_timeout : 300,
    skip_all_approvals: true,
  };
  const response = await request(backend, "/api/permissions/policy", {
    method: "PUT",
    body: policy as Record<string, unknown>,
  });
  return {
    name: `${backend.name}:execution-permission-policy`,
    status: response.status === 200 ? "pass" : "warn",
    detail: `status=${response.status} mode=dangerously_skip_permissions skip_all_approvals=true`,
  };
}

async function restorePermissionPolicy(backend: Backend, originalPolicy: PermissionPolicy): Promise<CheckResult> {
  const response = await request(backend, "/api/permissions/policy", {
    method: "PUT",
    body: originalPolicy as Record<string, unknown>,
  });
  return {
    name: `${backend.name}:execution-permission-restore`,
    status: response.status === 200 ? "pass" : "warn",
    detail: `status=${response.status}`,
  };
}

async function waitForExecution(
  backend: Backend,
  sessionId: string,
  options: Options,
): Promise<{ completed: boolean; detail: string }> {
  const startedAt = Date.now();
  let lastDetail = "";
  while (Date.now() - startedAt < options.executionTimeoutMs) {
    const status = await request(backend, `/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
    const data = getResponseData(status.json);
    const running = getPath(data, ["has_running_task"]);
    const taskStatus = getPath(data, ["task_info", "status"]);
    lastDetail = `http=${status.status} running=${String(running)} task_status=${String(taskStatus)}`;
    if (taskStatus === "completed") {
      return { completed: true, detail: lastDetail };
    }
    if (taskStatus === "failed" || taskStatus === "interrupted") {
      return { completed: false, detail: lastDetail };
    }
    const messages = await request(backend, `/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=50&offset=0`);
    const items = getMessageItems(getResponseData(messages.json));
    if (items.some((item) => getPath(item, ["role"]) === "assistant" && String(getPath(item, ["content"]) ?? "").trim())) {
      return { completed: true, detail: `${lastDetail} assistant_message=true` };
    }
    await sleep(options.pollIntervalMs);
  }
  return { completed: false, detail: `timeout after ${options.executionTimeoutMs}ms; ${lastDetail}` };
}

async function fetchSnapshot(backend: Backend, options: Options): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  if (options.sessionId) {
    params.set("session_id", options.sessionId);
  }
  if (options.selectedLlm) {
    params.set("selected_llm", options.selectedLlm);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await request(backend, `/api/agent/context-snapshot${suffix}`);
  if (response.status !== 200) {
    return { __http_status: response.status, __error: response.text.slice(0, 300) };
  }
  const data = getResponseData(response.json);
  return isRecord(data) ? data : { __http_status: response.status, __error: "snapshot data is not an object" };
}

function checkSnapshotShape(label: string, snapshot: Record<string, unknown>): CheckResult {
  const prompt = getSystemPrompt(snapshot);
  const tools = getNames(snapshot, "available_tools");
  const tokenStats = getRecord(snapshot.token_stats);
  const ok =
    prompt.length > 1000 &&
    tools.length > 0 &&
    typeof tokenStats.system_prompt_tokens === "number" &&
    typeof tokenStats.total_tokens === "number";
  return {
    name: `${label}:snapshot-shape`,
    status: ok ? "pass" : "fail",
    detail: `prompt_length=${prompt.length} tools=${tools.length} system_tokens=${String(tokenStats.system_prompt_tokens)}`,
  };
}

function checkPromptNeedles(label: string, snapshot: Record<string, unknown>): CheckResult[] {
  const prompt = getSystemPrompt(snapshot);
  return PROMPT_NEEDLES.map(([name, needle]) => ({
    name: `${label}:prompt:${name}`,
    status: prompt.includes(needle) ? "pass" : "fail",
    detail: prompt.includes(needle) ? "found" : `missing ${needle}`,
  }));
}

function checkCoreToolCoverage(label: string, snapshot: Record<string, unknown>): CheckResult[] {
  const toolNames = getNames(snapshot, "available_tools");
  return CORE_TOOL_NAMES.map((toolName) => ({
    name: `${label}:tool:${toolName}`,
    status: toolNames.includes(toolName) ? "pass" : "fail",
    detail: toolNames.includes(toolName) ? "available" : `missing from [${toolNames.join(", ")}]`,
  }));
}

function checkSetParity(input: {
  name: string;
  leftLabel: string;
  rightLabel: string;
  left: string[];
  right: string[];
  strict: boolean;
}): CheckResult {
  const leftOnly = difference(input.left, input.right);
  const rightOnly = difference(input.right, input.left);
  const ok = leftOnly.length === 0 && rightOnly.length === 0;
  return {
    name: input.name,
    status: ok ? "pass" : input.strict ? "fail" : "warn",
    detail: `${input.leftLabel}_only=[${leftOnly.join(", ")}] ${input.rightLabel}_only=[${rightOnly.join(", ")}]`,
  };
}

async function request(
  backend: Backend,
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT";
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    tolerateNonJson?: boolean;
  } = {},
): Promise<HttpResult> {
  const requestInit: RequestInit = {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  };
  if (options.body) {
    requestInit.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${backend.baseUrl}${path}`, requestInit);
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  let json: unknown | null = null;
  if (contentType.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      if (!options.tolerateNonJson) {
        throw new Error(`${backend.name} ${path} returned invalid JSON: ${String(error)}`);
      }
    }
  }
  return {
    status: response.status,
    contentType,
    json,
    text,
  };
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    pythonBaseUrl: process.env.PARITY_PYTHON_URL ?? "http://127.0.0.1:5001",
    tsBaseUrl: process.env.PARITY_TS_URL ?? "http://127.0.0.1:5002",
    sessionId: process.env.PARITY_SESSION_ID ?? null,
    selectedLlm: process.env.PARITY_SELECTED_LLM ?? "rag|deepseek|deepseek-v4-pro",
    includeExecution: false,
    executionTask: process.env.PARITY_EXECUTION_TASK ?? DEFAULT_EXECUTION_TASK,
    customExecutionTask: process.env.PARITY_EXECUTION_TASK !== undefined,
    executionProfile: parseExecutionProfile(process.env.PARITY_EXECUTION_PROFILE ?? DEFAULT_EXECUTION_PROFILE),
    executionTimeoutMs: Number.parseInt(process.env.PARITY_EXECUTION_TIMEOUT_MS ?? "120000", 10),
    pollIntervalMs: 1000,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--include-execution") {
      options.includeExecution = true;
      continue;
    }
    if (arg === "--no-selected-llm") {
      options.selectedLlm = null;
      continue;
    }
    if (arg === "--python") {
      options.pythonBaseUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--ts") {
      options.tsBaseUrl = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--selected-llm") {
      options.selectedLlm = requireValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--execution-task") {
      options.executionTask = requireValue(args, index, arg);
      options.customExecutionTask = true;
      index += 1;
      continue;
    }
    if (arg === "--execution-profile") {
      options.executionProfile = parseExecutionProfile(requireValue(args, index, arg));
      options.customExecutionTask = false;
      index += 1;
      continue;
    }
    if (arg === "--execution-timeout-ms") {
      options.executionTimeoutMs = Number.parseInt(requireValue(args, index, arg), 10);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run smoke:parity -- [options]

Options:
  --python <url>              Python backend URL. Default: http://127.0.0.1:5001
  --ts <url>                  TypeScript backend URL. Default: http://127.0.0.1:5002
  --session-id <id>           Existing session id for snapshot/task-status checks.
  --selected-llm <value>      selected_llm query/body value. Default: rag|deepseek|deepseek-v4-pro
  --no-selected-llm           Do not send selected_llm.
  --include-execution         Also run a real LLM-backed /api/agent/stream smoke.
  --execution-task <text>     Custom single task for --include-execution.
  --execution-profile <name>  minimal, core, or full. Default: core
  --execution-timeout-ms <n>  Execution timeout. Default: 120000
`);
}

function printReport(results: CheckResult[], summary: Record<string, unknown>): void {
  console.log("Parity smoke summary:");
  console.log(JSON.stringify(summary, null, 2));
  console.log("");
  for (const result of results) {
    const marker = result.status === "pass" ? "PASS" : result.status === "warn" ? "WARN" : "FAIL";
    console.log(`${marker} ${result.name} - ${result.detail}`);
  }
  const pass = results.filter((result) => result.status === "pass").length;
  const warn = results.filter((result) => result.status === "warn").length;
  const fail = results.filter((result) => result.status === "fail").length;
  console.log("");
  console.log(`Totals: pass=${pass} warn=${warn} fail=${fail}`);
}

function getSystemPrompt(snapshot: Record<string, unknown>): string {
  return typeof snapshot.system_prompt === "string" ? snapshot.system_prompt : "";
}

function getNames(snapshot: Record<string, unknown>, key: "available_tools" | "available_agent_tools" | "available_skills"): string[] {
  const items = Array.isArray(snapshot[key]) ? snapshot[key] : [];
  return items
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const name = item.name ?? item.agent_name;
      return typeof name === "string" && name.trim() ? name.trim() : null;
    })
    .filter((name): name is string => name !== null)
    .sort((left, right) => left.localeCompare(right));
}

function getMessageItems(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.items)) {
    return data.items.filter(isRecord);
  }
  return [];
}

function getRunStepItems(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.items)) {
    return data.items.filter(isRecord);
  }
  return [];
}

function getToolNamesFromRunSteps(runSteps: Record<string, unknown>[]): string[] {
  const names: string[] = [];
  for (const step of runSteps) {
    if (step.kind !== "tool") {
      continue;
    }
    const name = step.tool_name;
    if (typeof name === "string" && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

function getResponseData(value: unknown): unknown {
  if (isRecord(value) && "data" in value) {
    return value.data;
  }
  return value;
}

function getPath(value: unknown, path: string[]): unknown {
  let cursor = value;
  for (const part of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function getRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function requireValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function parseExecutionProfile(value: string): ExecutionProfile {
  const normalized = value.trim().toLowerCase();
  if (normalized === "minimal" || normalized === "core" || normalized === "full") {
    return normalized;
  }
  throw new Error(`Unsupported execution profile: ${value}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
