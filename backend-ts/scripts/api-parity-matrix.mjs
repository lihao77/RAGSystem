const PY = process.env.PARITY_PYTHON_URL ?? "http://127.0.0.1:5001";
const TS = process.env.PARITY_TS_URL ?? "http://127.0.0.1:5002";
const STAMP = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const TEST = `codex-parity-${STAMP}`;
const TIMEOUT_MS = Number(process.env.PARITY_API_TIMEOUT_MS ?? 15000);

const methods = ["get", "post", "put", "patch", "delete"];

const hardSkip = new Map([
  ["POST /api/agent/execute", "would run LLM synchronously"],
  ["POST /api/agent/execute/{agent_name}", "would run LLM synchronously"],
  ["POST /api/agent/metrics/reset", "mutates metrics counters"],
  ["POST /api/agent/agents/reload", "mutates runtime agent cache"],
  ["PUT /api/agent-config/configs/{agent_name}", "creates/replaces agent config; unsafe for missing test id"],
  ["POST /api/agent-config/teams/{team_name}/activate", "switches active team"],
  ["POST /api/agent-config/teams/default/reset", "destructive config reset"],
  ["POST /api/daemon/start", "mutates daemon process state"],
  ["POST /api/daemon/stop", "mutates daemon process state"],
  ["POST /api/system-config/reload", "mutates runtime config cache"],
  ["PATCH /api/system-config", "mutates system config"],
  ["DELETE /api/permissions/auto-accept/all", "clears existing permission policy"],
  ["POST /api/vector-library/migrate", "potentially mutates vector store broadly"],
]);

const handledSeparately = new Set([
  "POST /api/agent/sessions",
  "POST /api/files/upload",
  "POST /api/agent/sessions/{session_id}/files/upload",
  "GET /api/files/{file_id}",
  "GET /api/files/{file_id}/download",
  "DELETE /api/files/{file_id}",
  "GET /api/agent/sessions/{session_id}/files/{file_id}",
  "GET /api/agent/sessions/{session_id}/files/{file_id}/download",
  "DELETE /api/agent/sessions/{session_id}/files/{file_id}",
  "POST /api/permissions/auto-accept",
  "DELETE /api/permissions/auto-accept",
  "PUT /api/permissions/mode",
  "PUT /api/permissions/policy",
]);

async function main() {
  const openapi = await fetchJson(`${PY}/openapi.json`);
  const routeCases = buildCases(openapi);
  const results = [];
  const skipped = [];

  for (const routeCase of routeCases) {
    const key = `${routeCase.method} ${routeCase.template}`;
    if (hardSkip.has(key)) {
      skipped.push({ ...routeCase, reason: hardSkip.get(key) });
      continue;
    }
    if (handledSeparately.has(key)) {
      skipped.push({ ...routeCase, reason: "covered by cleanup-aware scenario" });
      continue;
    }
    const [py, ts] = shouldRunSerial(routeCase)
      ? [await request(PY, routeCase), await request(TS, routeCase)]
      : await Promise.all([request(PY, routeCase), request(TS, routeCase)]);
    results.push(record(routeCase, py, ts));
  }

  results.push(...await sessionLifecycleScenario());
  results.push(...await fileScenario("global"));
  results.push(...await fileScenario("session"));
  results.push(...await permissionScenario());
  results.push(...await agentConfigScenario());
  results.push(...await mcpScenario());
  results.push(...await daemonCronScenario());
  results.push(...await websocketScenario());

  printReport(results, skipped);
  process.exitCode = results.some((item) => item.comparison.severity === "fail") ? 1 : 0;
}

function buildCases(openapi) {
  const cases = [];
  for (const [template, pathItem] of Object.entries(openapi.paths ?? {})) {
    for (const method of methods) {
      if (!pathItem?.[method]) {
        continue;
      }
      const methodUpper = method.toUpperCase();
      cases.push({
        name: `${methodUpper} ${template}`,
        method: methodUpper,
        template,
        path: buildPath(template, methodUpper),
        body: buildBody(template, methodUpper),
        headers: {},
        timeoutMs: template === "/api/mcp/registry/servers" ? 30000 : TIMEOUT_MS,
      });
    }
  }
  return cases.sort((left, right) => left.name.localeCompare(right.name));
}

function shouldRunSerial(routeCase) {
  const key = `${routeCase.method} ${routeCase.template}`;
  return new Set([
    "DELETE /api/vector/collections/{collection_name}",
    "DELETE /api/vector/documents/{collection_name}/{document_id}",
    "POST /api/vector-library/delete-file",
    "POST /api/vector-library/index-file",
    "POST /api/vector-library/vectorizers",
    "POST /api/vector-library/rerankers",
  ]).has(key);
}

function buildPath(template, method) {
  let path = template.replace(/\{([^}]+)\}/g, (_match, name) => encodeURIComponent(pathParam(name)));
  const params = new URLSearchParams();

  if (template === "/{full_path}") {
    path = "/__codex_parity_missing_static__";
  }
  if (template === "/api/artifacts/visualizations") {
    params.set("session_id", `${TEST}-missing-session`);
  }
  if (template === "/api/agent/context-snapshot") {
    params.set("selected_llm", "rag|deepseek|deepseek-v4-pro");
  }
  if (template === "/api/agent/sessions") {
    params.set("limit", "5");
    params.set("offset", "0");
  }
  if (template === "/api/agent/sessions/{session_id}/messages") {
    params.set("limit", "5");
    params.set("offset", "0");
    params.set("expand", "none");
  }
  if (template === "/api/agent/sessions/{session_id}/messages/{message_id}/run-steps") {
    params.set("limit", "5");
    params.set("offset", "0");
  }
  if (template === "/api/agent/execution/overview") {
    params.set("active_only", "false");
  }
  if (template === "/api/daemon/agents/{team_name}/heartbeat" || template === "/api/daemon/cron/tasks/{task_id}/history") {
    params.set("limit", "3");
  }
  if (template === "/api/mcp/registry/servers") {
    params.set("search", "");
    params.set("limit", "1");
    params.set("latest_only", "true");
  }
  if (template === "/api/embedding-models/models/sync-status") {
    params.set("collection", "default");
  }
  if (template === "/api/agent/context-snapshot/message-content") {
    params.set("session_id", `${TEST}-missing-session`);
    params.set("message_id", `${TEST}-missing-message`);
  }
  if (template === "/api/agent/tool-call/raw-result") {
    params.set("session_id", `${TEST}-missing-session`);
    params.set("message_id", `${TEST}-missing-message`);
    params.set("step_id", `${TEST}-missing-step`);
  }

  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function pathParam(name) {
  if (name === "agent_name" || name === "agentName") return `${TEST}-missing-agent`;
  if (name === "team_name" || name === "teamName") return `${TEST}-missing-team`;
  if (name === "session_id" || name === "sessionId") return `${TEST}-missing-session`;
  if (name === "message_id" || name === "messageId") return `${TEST}-missing-message`;
  if (name === "approval_id" || name === "approvalId") return `${TEST}-missing-approval`;
  if (name === "input_id" || name === "inputId") return `${TEST}-missing-input`;
  if (name === "file_id" || name === "fileId") return `${TEST}-missing-file`;
  if (name === "artifact_id" || name === "artifactId") return `${TEST}-missing-artifact`;
  if (name === "task_id" || name === "taskId") return `${TEST}-missing-task`;
  if (name === "server_name" || name === "serverName") return `${TEST}-missing-server`;
  if (name === "provider_key" || name === "providerKey") return `${TEST}-missing-provider`;
  if (name === "collection_name" || name === "collectionName") return `${TEST}-missing-collection`;
  if (name === "document_id" || name === "documentId") return `${TEST}-missing-document`;
  if (name === "model_id" || name === "modelId") return "999999999";
  if (name === "key") return `${TEST}-missing-key`;
  if (name === "platform") return `${TEST}-platform`;
  if (name === "full_path") return "__codex_parity_missing_static__";
  return `${TEST}-missing-${name.replace(/_/g, "-")}`;
}

function buildBody(template, method) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return undefined;

  if (template === "/api/agent/agents/create") return {};
  if (template === "/api/agent/collaborate") return { tasks: [] };
  if (template === "/api/agent/stream") return {};
  if (template === "/api/agent/stream/stop") return { session_id: `${TEST}-missing-session` };
  if (template.includes("/approvals/")) return { approved: false, message: "parity" };
  if (template.includes("/inputs/")) return { value: "parity" };
  if (template.endsWith("/files/validate") || template === "/api/files/validate") return { file_ids: [`${TEST}-missing-file`] };
  if (template.endsWith("/rollback")) return {};
  if (template.endsWith("/rollback-and-retry")) return {};
  if (template.endsWith("/recover")) return {};
  if (template.includes("/messages/{message_id}")) return { content: "parity" };
  if (template.includes("/configs/{agent_name}") && method === "PATCH") return { description: "parity" };
  if (template.includes("/configs/{agent_name}") && method === "PUT") return { agent_name: "" };
  if (template.endsWith("/preset")) return { preset: "default" };
  if (template.endsWith("/import")) return { invalid: true };
  if (template === "/api/agent-config/teams") return { team_name: "" };
  if (template.endsWith("/rename")) return { new_team_name: `${TEST}-renamed-team` };
  if (template.endsWith("/copy-agents")) return { source_team: "default", agent_names: [] };
  if (template === "/api/daemon/config") return { enabled: false, agents: [], default_session_ttl: 0 };
  if (template.endsWith("/agents/{team_name}/test")) return { platform: "feishu", content: "parity" };
  if (template === "/api/daemon/send") return { platform: "feishu" };
  if (template === "/api/daemon/cron/tasks") return { task_id: "", cron: "", task: "", team_name: "" };
  if (template.includes("/daemon/cron/tasks/{task_id}")) return method === "PUT" ? { enabled: false } : {};
  if (template.includes("/embedding-models/models/{model_id}")) return {};
  if (template === "/api/mcp/registry/install") return {};
  if (template === "/api/mcp/servers") return { name: "" };
  if (template.includes("/api/mcp/servers/{server_name}")) return method === "PUT" ? { transport: "stdio", command: "echo", args: [] } : {};
  if (template === "/api/model-adapter/providers") return {};
  if (template === "/api/model-adapter/providers/order") return { provider_keys: [] };
  if (template.includes("/api/model-adapter/providers/{provider_key}")) return {};
  if (template === "/api/model-adapter/test") return { provider: `${TEST}-missing-provider`, prompt: "parity" };
  if (template === "/api/vector-library/index-file") {
    return { collection: "default", file_id: `${TEST}-missing-file`, vectorizer_key: `${TEST}-missing-vectorizer` };
  }
  if (template === "/api/vector-library/delete-file") return { collection: "default", file_id: `${TEST}-missing-file` };
  if (template === "/api/vector-library/vectorizers") return { provider_key: "", model_name: "" };
  if (template.includes("/api/vector-library/vectorizers/{key}")) return {};
  if (template === "/api/vector-library/rerankers") return { mode: "model", provider_key: "", model_name: "" };
  if (template.includes("/api/vector-library/rerankers/{key}")) return {};
  if (template === "/api/vector/search") return { query: "", collection: "default" };
  if (template === "/api/vector/index") return {};
  return {};
}

async function sessionLifecycleScenario() {
  const pySession = `${TEST}-py-session`;
  const tsSession = `${TEST}-ts-session`;
  const results = [];
  const createPy = await request(PY, {
    name: "session-create-success",
    method: "POST",
    path: "/api/agent/sessions",
    body: { session_id: pySession, user_id: "codex-parity", metadata: { parity: TEST } },
  });
  const createTs = await request(TS, {
    name: "session-create-success",
    method: "POST",
    path: "/api/agent/sessions",
    body: { session_id: tsSession, user_id: "codex-parity", metadata: { parity: TEST } },
  });
  results.push(record({ name: "session-create-success", method: "POST", path: "/api/agent/sessions" }, createPy, createTs));

  for (const [name, suffix] of [
    ["session-get-created", ""],
    ["session-messages-created", "/messages?limit=5&offset=0"],
  ]) {
    const [py, ts] = await Promise.all([
      request(PY, { name, method: "GET", path: `/api/agent/sessions/${encodeURIComponent(pySession)}${suffix}` }),
      request(TS, { name, method: "GET", path: `/api/agent/sessions/${encodeURIComponent(tsSession)}${suffix}` }),
    ]);
    results.push(record({ name, method: "GET", path: `/api/agent/sessions/{test-session}${suffix}` }, py, ts));
  }

  const [deletePy, deleteTs] = await Promise.all([
    request(PY, { name: "session-delete-created", method: "DELETE", path: `/api/agent/sessions/${encodeURIComponent(pySession)}` }),
    request(TS, { name: "session-delete-created", method: "DELETE", path: `/api/agent/sessions/${encodeURIComponent(tsSession)}` }),
  ]);
  results.push(record({ name: "session-delete-created", method: "DELETE", path: "/api/agent/sessions/{test-session}" }, deletePy, deleteTs));
  return results;
}

async function fileScenario(scope) {
  const isSession = scope === "session";
  const pySession = `${TEST}-py-file-session`;
  const tsSession = `${TEST}-ts-file-session`;
  const pyPrefix = isSession ? `/api/agent/sessions/${encodeURIComponent(pySession)}/files` : "/api/files";
  const tsPrefix = isSession ? `/api/agent/sessions/${encodeURIComponent(tsSession)}/files` : "/api/files";
  const results = [];

  if (isSession) {
    await request(PY, { name: "session-file-create-py-session", method: "POST", path: "/api/agent/sessions", body: { session_id: pySession } });
    await request(TS, { name: "session-file-create-ts-session", method: "POST", path: "/api/agent/sessions", body: { session_id: tsSession } });
  }

  const uploadPy = await requestMultipart(PY, `${pyPrefix}/upload`, `${TEST}-py-${scope}.txt`, `python ${TEST}`);
  const uploadTs = await requestMultipart(TS, `${tsPrefix}/upload`, `${TEST}-ts-${scope}.txt`, `ts ${TEST}`);
  results.push(record({ name: `${scope}-file-upload-success`, method: "POST", path: `${isSession ? "/api/agent/sessions/{session_id}/files" : "/api/files"}/upload` }, uploadPy, uploadTs));

  const pyFileId = extractFileId(uploadPy.json);
  const tsFileId = extractFileId(uploadTs.json);
  if (pyFileId && tsFileId) {
    for (const [name, suffix] of [
      [`${scope}-file-get-created`, ""],
      [`${scope}-file-download-created`, "/download"],
    ]) {
      const [py, ts] = await Promise.all([
        request(PY, { name, method: "GET", path: `${pyPrefix}/${encodeURIComponent(pyFileId)}${suffix}` }),
        request(TS, { name, method: "GET", path: `${tsPrefix}/${encodeURIComponent(tsFileId)}${suffix}` }),
      ]);
      results.push(record({ name, method: "GET", path: `${isSession ? "/api/agent/sessions/{session_id}/files" : "/api/files"}/{file_id}${suffix}` }, py, ts));
    }

    const validatePathPy = isSession ? `${pyPrefix}/validate` : "/api/files/validate";
    const validatePathTs = isSession ? `${tsPrefix}/validate` : "/api/files/validate";
    const [validPy, validTs] = await Promise.all([
      request(PY, { name: `${scope}-file-validate-created`, method: "POST", path: validatePathPy, body: { file_ids: [pyFileId] } }),
      request(TS, { name: `${scope}-file-validate-created`, method: "POST", path: validatePathTs, body: { file_ids: [tsFileId] } }),
    ]);
    results.push(record({ name: `${scope}-file-validate-created`, method: "POST", path: `${isSession ? "/api/agent/sessions/{session_id}/files" : "/api/files"}/validate` }, validPy, validTs));

    const [deletePy, deleteTs] = await Promise.all([
      request(PY, { name: `${scope}-file-delete-created`, method: "DELETE", path: `${pyPrefix}/${encodeURIComponent(pyFileId)}` }),
      request(TS, { name: `${scope}-file-delete-created`, method: "DELETE", path: `${tsPrefix}/${encodeURIComponent(tsFileId)}` }),
    ]);
    results.push(record({ name: `${scope}-file-delete-created`, method: "DELETE", path: `${isSession ? "/api/agent/sessions/{session_id}/files" : "/api/files"}/{file_id}` }, deletePy, deleteTs));
  } else {
    results.push({
      case: { name: `${scope}-file-derived-tests`, method: "GET", path: "n/a" },
      py: uploadPy,
      ts: uploadTs,
      comparison: { severity: "fail", detail: "could not extract uploaded file ids" },
    });
  }

  if (isSession) {
    await request(PY, { name: "session-file-delete-py-session", method: "DELETE", path: `/api/agent/sessions/${encodeURIComponent(pySession)}` });
    await request(TS, { name: "session-file-delete-ts-session", method: "DELETE", path: `/api/agent/sessions/${encodeURIComponent(tsSession)}` });
  }
  return results;
}

async function permissionScenario() {
  const results = [];
  const getCase = { name: "permissions-policy", method: "GET", path: "/api/permissions/policy" };
  const [origPy, origTs] = await Promise.all([request(PY, getCase), request(TS, getCase)]);
  results.push(record(getCase, origPy, origTs));

  const policy = { mode: "standard", auto_accept_patterns: [], audit_all_checks: false, approval_timeout: 300, skip_all_approvals: false };
  const putCase = { name: "permissions-policy-put", method: "PUT", path: "/api/permissions/policy", body: policy };
  const [putPy, putTs] = await Promise.all([request(PY, putCase), request(TS, putCase)]);
  results.push(record(putCase, putPy, putTs));

  const modeCase = { name: "permissions-mode-put", method: "PUT", path: "/api/permissions/mode", body: { mode: "standard" } };
  const [modePy, modeTs] = await Promise.all([request(PY, modeCase), request(TS, modeCase)]);
  results.push(record(modeCase, modePy, modeTs));

  const pattern = { pattern_type: "command", pattern_value: `echo ${TEST}`, description: "codex parity temporary" };
  const addCase = { name: "permissions-auto-accept-add", method: "POST", path: "/api/permissions/auto-accept", body: pattern };
  const [addPy, addTs] = await Promise.all([request(PY, addCase), request(TS, addCase)]);
  results.push(record(addCase, addPy, addTs));

  const deleteCase = { name: "permissions-auto-accept-delete", method: "DELETE", path: "/api/permissions/auto-accept", body: pattern };
  const [deletePy, deleteTs] = await Promise.all([request(PY, deleteCase), request(TS, deleteCase)]);
  results.push(record(deleteCase, deletePy, deleteTs));

  if (origPy.json) await request(PY, { name: "permissions-restore-py", method: "PUT", path: "/api/permissions/policy", body: responseData(origPy.json) });
  if (origTs.json) await request(TS, { name: "permissions-restore-ts", method: "PUT", path: "/api/permissions/policy", body: responseData(origTs.json) });
  return results;
}

async function agentConfigScenario() {
  const pyAgent = `${TEST}_py_agent`;
  const tsAgent = `${TEST}_ts_agent`;
  const results = [];
  const createPyBody = { agent_name: pyAgent, display_name: pyAgent, description: "codex parity temp", default_entry: false };
  const createTsBody = { agent_name: tsAgent, display_name: tsAgent, description: "codex parity temp", default_entry: false };
  const [createPy, createTs] = await Promise.all([
    request(PY, { name: "agent-create-success", method: "POST", path: "/api/agent/agents/create", body: createPyBody }),
    request(TS, { name: "agent-create-success", method: "POST", path: "/api/agent/agents/create", body: createTsBody }),
  ]);
  results.push(record({ name: "agent-create-success", method: "POST", path: "/api/agent/agents/create" }, createPy, createTs));

  for (const [name, suffix] of [
    ["agent-config-get-created", ""],
    ["agent-config-validate-created", "/validate"],
    ["agent-config-export-created", "/export?format=json"],
  ]) {
    const [py, ts] = await Promise.all([
      request(PY, { name, method: "GET", path: `/api/agent-config/configs/${encodeURIComponent(pyAgent)}${suffix}` }),
      request(TS, { name, method: "GET", path: `/api/agent-config/configs/${encodeURIComponent(tsAgent)}${suffix}` }),
    ]);
    results.push(record({ name, method: "GET", path: `/api/agent-config/configs/{test-agent}${suffix}` }, py, ts));
  }

  const [patchPy, patchTs] = await Promise.all([
    request(PY, { name: "agent-config-patch-created", method: "PATCH", path: `/api/agent-config/configs/${encodeURIComponent(pyAgent)}`, body: { description: "codex parity patched" } }),
    request(TS, { name: "agent-config-patch-created", method: "PATCH", path: `/api/agent-config/configs/${encodeURIComponent(tsAgent)}`, body: { description: "codex parity patched" } }),
  ]);
  results.push(record({ name: "agent-config-patch-created", method: "PATCH", path: "/api/agent-config/configs/{test-agent}" }, patchPy, patchTs));

  const [deletePy, deleteTs] = await Promise.all([
    request(PY, { name: "agent-delete-created", method: "DELETE", path: `/api/agent/agents/delete/${encodeURIComponent(pyAgent)}` }),
    request(TS, { name: "agent-delete-created", method: "DELETE", path: `/api/agent/agents/delete/${encodeURIComponent(tsAgent)}` }),
  ]);
  results.push(record({ name: "agent-delete-created", method: "DELETE", path: "/api/agent/agents/delete/{test-agent}" }, deletePy, deleteTs));
  return results;
}

async function mcpScenario() {
  const pyServer = `${TEST}-py-mcp`;
  const tsServer = `${TEST}-ts-mcp`;
  const body = (name) => ({
    name,
    display_name: name,
    transport: "stdio",
    command: "node",
    args: ["-e", "process.exit(0)"],
    enabled: false,
    auto_connect: false,
    timeout: 5,
    risk_level: "low",
  });
  const results = [];
  // Both backends use the same ~/.ragsystem MCP YAML. Run each side's
  // create/update/delete sequence serially to avoid one process overwriting the
  // other's temporary server entry while the scenario is in flight.
  const createPy = await request(PY, { name: "mcp-server-create-success", method: "POST", path: "/api/mcp/servers", body: body(pyServer) });
  const updatePy = await request(PY, { name: "mcp-server-update-created", method: "PUT", path: `/api/mcp/servers/${encodeURIComponent(pyServer)}`, body: body(pyServer) });
  const toolsPy = await request(PY, { name: "mcp-server-tools-created", method: "GET", path: `/api/mcp/servers/${encodeURIComponent(pyServer)}/tools` });
  const deletePy = await request(PY, { name: "mcp-server-delete-created", method: "DELETE", path: `/api/mcp/servers/${encodeURIComponent(pyServer)}` });

  const createTs = await request(TS, { name: "mcp-server-create-success", method: "POST", path: "/api/mcp/servers", body: body(tsServer) });
  const updateTs = await request(TS, { name: "mcp-server-update-created", method: "PUT", path: `/api/mcp/servers/${encodeURIComponent(tsServer)}`, body: body(tsServer) });
  const toolsTs = await request(TS, { name: "mcp-server-tools-created", method: "GET", path: `/api/mcp/servers/${encodeURIComponent(tsServer)}/tools` });
  const deleteTs = await request(TS, { name: "mcp-server-delete-created", method: "DELETE", path: `/api/mcp/servers/${encodeURIComponent(tsServer)}` });

  results.push(record({ name: "mcp-server-create-success", method: "POST", path: "/api/mcp/servers" }, createPy, createTs));
  results.push(record({ name: "mcp-server-update-created", method: "PUT", path: "/api/mcp/servers/{test-server}" }, updatePy, updateTs));
  results.push(record({ name: "mcp-server-tools-created", method: "GET", path: "/api/mcp/servers/{test-server}/tools" }, toolsPy, toolsTs));
  results.push(record({ name: "mcp-server-delete-created", method: "DELETE", path: "/api/mcp/servers/{test-server}" }, deletePy, deleteTs));
  return results;
}

async function daemonCronScenario() {
  const pyTask = `${TEST}-py-cron`;
  const tsTask = `${TEST}-ts-cron`;
  const body = (taskId) => ({
    task_id: taskId,
    name: taskId,
    cron: "0 0 * * *",
    task: "Reply exactly: parity",
    team_name: "default",
    entry_agent: null,
    enabled: false,
  });
  const results = [];
  // daemon cron tasks are persisted inside the shared daemon YAML. Keep the two
  // backend lifecycles serial so the comparison measures endpoint behavior, not
  // concurrent file replacement.
  const createPy = await request(PY, { name: "daemon-cron-create-success", method: "POST", path: "/api/daemon/cron/tasks", body: body(pyTask) });
  const createTs = await request(TS, { name: "daemon-cron-create-success", method: "POST", path: "/api/daemon/cron/tasks", body: body(tsTask) });
  results.push(record({ name: "daemon-cron-create-success", method: "POST", path: "/api/daemon/cron/tasks" }, createPy, createTs));

  const pyCreated = createPy.status >= 200 && createPy.status < 300;
  const tsCreated = createTs.status >= 200 && createTs.status < 300;
  if (!pyCreated || !tsCreated) {
    return results;
  }

  const updatePy = await request(PY, { name: "daemon-cron-update-created", method: "PUT", path: `/api/daemon/cron/tasks/${encodeURIComponent(pyTask)}`, body: { enabled: false } });
  const deletePy = await request(PY, { name: "daemon-cron-delete-created", method: "DELETE", path: `/api/daemon/cron/tasks/${encodeURIComponent(pyTask)}` });
  const updateTs = await request(TS, { name: "daemon-cron-update-created", method: "PUT", path: `/api/daemon/cron/tasks/${encodeURIComponent(tsTask)}`, body: { enabled: false } });
  const deleteTs = await request(TS, { name: "daemon-cron-delete-created", method: "DELETE", path: `/api/daemon/cron/tasks/${encodeURIComponent(tsTask)}` });

  results.push(record({ name: "daemon-cron-update-created", method: "PUT", path: "/api/daemon/cron/tasks/{test-task}" }, updatePy, updateTs));
  results.push(record({ name: "daemon-cron-delete-created", method: "DELETE", path: "/api/daemon/cron/tasks/{test-task}" }, deletePy, deleteTs));
  return results;
}

async function websocketScenario() {
  if (typeof WebSocket !== "function") {
    return [{
      case: { name: "ws-basic-open-stop", method: "WS", path: "/api/agent/sessions/{session_id}/ws" },
      py: { status: 0, json: { error: "global WebSocket unavailable" }, contentType: "", text: "" },
      ts: { status: 0, json: { error: "global WebSocket unavailable" }, contentType: "", text: "" },
      comparison: { severity: "warn", detail: "Node global WebSocket unavailable" },
    }];
  }
  const [py, ts] = await Promise.all([
    websocketOpenAndStop(PY, `${TEST}-py-ws`),
    websocketOpenAndStop(TS, `${TEST}-ts-ws`),
  ]);
  const opened = py.json.opened === ts.json.opened;
  const ack = py.json.stopAck === ts.json.stopAck;
  const severity = opened && ack && py.json.opened && py.json.stopAck ? "pass" : "fail";
  return [{
    case: { name: "ws-basic-open-stop", method: "WS", path: "/api/agent/sessions/{session_id}/ws" },
    py,
    ts,
    comparison: { severity, detail: `py=${py.json.opened}/${py.json.stopAck} ts=${ts.json.opened}/${ts.json.stopAck}` },
  }];
}

function websocketOpenAndStop(baseUrl, sessionId) {
  return new Promise((resolve) => {
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/api/agent/sessions/${encodeURIComponent(sessionId)}/ws`;
    const events = [];
    let opened = false;
    let stopAck = false;
    let settled = false;
    let socket;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve({
        status: opened ? 101 : 0,
        contentType: "websocket",
        json: { opened, stopAck, events, error },
        text: "",
      });
    };
    const timer = setTimeout(() => finish("timeout"), 5000);
    try {
      socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => {
        opened = true;
        socket.send(JSON.stringify({ type: "stop" }));
      }, { once: true });
      socket.addEventListener("message", (event) => {
        try {
          const parsed = JSON.parse(String(event.data));
          events.push({ type: parsed.type, stream_seq: typeof parsed.stream_seq === "number" });
          if (parsed.type === "stop.ack") {
            stopAck = true;
            finish();
          }
        } catch {
          events.push({ type: "unparsed" });
        }
      });
      socket.addEventListener("error", () => finish("websocket error"), { once: true });
      socket.addEventListener("close", () => finish(), { once: true });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  });
}

async function request(baseUrl, routeCase) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), routeCase.timeoutMs ?? TIMEOUT_MS);
  const init = {
    method: routeCase.method,
    signal: controller.signal,
    headers: {
      "x-request-id": `${TEST}-${routeCase.name}`,
      ...(routeCase.headers ?? {}),
    },
  };
  if (Object.prototype.hasOwnProperty.call(routeCase, "body") && routeCase.body !== undefined) {
    init.headers["content-type"] = routeCase.contentType ?? "application/json";
    init.body = routeCase.contentType ? routeCase.body : JSON.stringify(routeCase.body);
  }
  try {
    const response = await fetch(`${baseUrl}${routeCase.path}`, init);
    return await readResponse(response);
  } catch (error) {
    return {
      status: 0,
      contentType: "",
      json: null,
      text: error?.name === "AbortError" ? "AbortError" : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function requestMultipart(baseUrl, path, filename, content) {
  const form = new FormData();
  form.append("files", new Blob([content], { type: "text/plain" }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
      headers: { "x-request-id": `${TEST}-multipart-${filename}` },
    });
    return await readResponse(response);
  } catch (error) {
    return {
      status: 0,
      contentType: "",
      json: null,
      text: error?.name === "AbortError" ? "AbortError" : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let json = null;
  if (contentType.includes("json") || /^[\s\[{]/.test(text)) {
    try { json = JSON.parse(text); } catch {}
  }
  return {
    status: response.status,
    contentType,
    json,
    text: text.slice(0, 1000),
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
  return response.json();
}

function record(routeCase, py, ts) {
  return { case: routeCase, py, ts, comparison: compare(py, ts, routeCase) };
}

function compare(py, ts, routeCase) {
  if (py.status !== ts.status) {
    return { severity: "fail", detail: `status ${py.status} != ${ts.status}` };
  }

  const pyJson = normalize(py.json, routeCase.name);
  const tsJson = normalize(ts.json, routeCase.name);
  if (pyJson === null && tsJson === null) {
    const pyKind = py.contentType.split(";")[0] || classifyText(py.text);
    const tsKind = ts.contentType.split(";")[0] || classifyText(ts.text);
    return pyKind === tsKind
      ? { severity: "pass", detail: `status=${py.status} non-json=${pyKind}` }
      : { severity: "warn", detail: `non-json type ${pyKind} != ${tsKind}` };
  }
  if ((pyJson === null) !== (tsJson === null)) {
    return { severity: "warn", detail: `json presence differs py=${pyJson !== null} ts=${tsJson !== null}` };
  }

  const pyShape = shape(pyJson);
  const tsShape = shape(tsJson);
  if (pyShape !== tsShape) {
    return {
      severity: py.status >= 400 ? "warn" : "fail",
      detail: `shape differs py=${truncate(pyShape)} ts=${truncate(tsShape)}`,
    };
  }

  const pySignature = signature(pyJson);
  const tsSignature = signature(tsJson);
  if (pySignature !== tsSignature) {
    return { severity: "warn", detail: `signature differs py=${truncate(pySignature)} ts=${truncate(tsSignature)}` };
  }
  return { severity: "pass", detail: `status=${py.status} shape ok` };
}

function normalize(value, caseName) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => normalize(item, caseName));
  if (typeof value !== "object") return normalizeScalar(value);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (dropKey(key, caseName)) continue;
    out[key] = normalize(value[key], caseName);
  }
  return out;
}

function dropKey(key, caseName) {
  if (["message", "detail", "details", "error", "content", "description", "title", "system_prompt", "code", "statusCode"].includes(key)) return true;
  if (caseName.includes("context-snapshot") && ["available_tools", "available_skills", "available_agent_tools"].includes(key)) return false;
  return /(^|_)(id|uuid|time|timestamp|at|seq|count|token|duration|elapsed|path|root|url|endpoint|key|secret|api_key|hash)(_|$)|^(id|created_at|updated_at|last_message_at|started_at|finished_at|run_id|task_id|request_id|session_id|message_id|file_id|artifact_id|provider_key|vectorizer_key|reranker_key|stored_path|file_path|path|thread_key|child_agent_id)$/i.test(key);
}

function normalizeScalar(value) {
  if (typeof value === "number") return Number.isInteger(value) ? "<int>" : "<number>";
  if (typeof value === "string") {
    if (value.includes("codex-parity-")) return "<test-id>";
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return "<datetime>";
    if (/^[0-9a-f-]{16,}$/i.test(value)) return "<id>";
    if (/^[0-9a-f-]{8,12}$/i.test(value)) return "<id>";
    return value.length > 80 ? "<long-string>" : value;
  }
  return value;
}

function shape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(shape).join("|")}]`;
  if (typeof value !== "object") return typeof value;
  return `{${Object.keys(value).sort().map((key) => `${key}:${shape(value[key])}`).join(",")}}`;
}

function signature(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `arr:${value.length}:${value.map(signature).join("|")}`;
  if (typeof value !== "object") return String(value);
  return Object.keys(value).sort().map((key) => `${key}=${signature(value[key])}`).join("&");
}

function responseData(json) {
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

function extractFileId(json) {
  const data = responseData(json);
  const files = data?.files ?? json?.files;
  const first = Array.isArray(files) ? files[0] : null;
  return first?.id ?? first?.file_id ?? null;
}

function classifyText(text) {
  if (!text) return "empty";
  if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) return "text/html";
  return "text/plain";
}

function truncate(value, max = 320) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function printReport(results, skipped) {
  const totals = {
    pass: results.filter((item) => item.comparison.severity === "pass").length,
    warn: results.filter((item) => item.comparison.severity === "warn").length,
    fail: results.filter((item) => item.comparison.severity === "fail").length,
  };
  console.log(`API parity matrix ${TEST}`);
  console.log(`executed=${results.length} pass=${totals.pass} warn=${totals.warn} fail=${totals.fail} skipped=${skipped.length}`);
  console.log("");

  for (const item of results) {
    const marker = item.comparison.severity.toUpperCase().padEnd(4);
    console.log(`${marker} ${item.case.name} ${item.case.method ?? ""} ${item.case.path ?? ""} :: ${item.comparison.detail}`);
    if (item.comparison.severity !== "pass") {
      console.log(`     py status=${item.py.status} ct=${item.py.contentType} body=${truncate(JSON.stringify(item.py.json ?? item.py.text), 600)}`);
      console.log(`     ts status=${item.ts.status} ct=${item.ts.contentType} body=${truncate(JSON.stringify(item.ts.json ?? item.ts.text), 600)}`);
    }
  }

  console.log("");
  console.log("Skipped:");
  for (const item of skipped) {
    console.log(`SKIP ${item.method} ${item.template} :: ${item.reason}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
