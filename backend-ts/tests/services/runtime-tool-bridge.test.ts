import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { MemoryStore } from "../../src/services/memory-store.js";
import { MemoryToolService, type RuntimeMemorySessionPort } from "../../src/services/memory-tool-service.js";
import { InMemoryEventBus } from "../../src/services/event-bus.js";
import { LocalBashToolService } from "../../src/services/local-bash-tool-service.js";
import { LocalDocumentToolService } from "../../src/services/local-document-tool-service.js";
import { PendingInteractionService } from "../../src/services/pending-interaction-service.js";
import { PermissionPolicyService } from "../../src/services/permission-policy-service.js";
import { RuntimeToolBridge } from "../../src/services/runtime-tool-bridge.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class InMemorySessions implements RuntimeMemorySessionPort {
  constructor(private readonly metadataBySession: Record<string, Record<string, unknown>>) {}

  getSession(sessionId: string) {
    return { metadata: this.metadataBySession[sessionId] ?? {} };
  }
}

describe("RuntimeToolBridge", () => {
  it("exposes read-only memory tools from agent memory allowed scopes", () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );

    expect(bridge.listVisibleToolNames(minimalAgent(["session"]))).toEqual([
      "list_memory_index",
      "read_memory_entry",
    ]);
    expect(bridge.listVisibleTools(minimalAgent(["session"]))).toEqual([
      expect.objectContaining({
        name: "list_memory_index",
        parameters: expect.objectContaining({
          required: ["scope"],
        }),
      }),
      expect.objectContaining({
        name: "read_memory_entry",
        parameters: expect.objectContaining({
          required: ["scope", "file_name"],
        }),
      }),
    ]);
    expect(bridge.listVisibleToolNames(minimalAgent([]))).toEqual([]);
  });

  it("dispatches list_memory_index and read_memory_entry calls to memory tools", () => {
    const dataRoot = makeTempDataRoot();
    writeFile(dataRoot, ["memory", "sessions", "s1", "MEMORY.md"], "# Session Memory\n");
    writeFile(dataRoot, ["memory", "sessions", "s1", "fact_alpha.md"], "alpha body\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
    );
    const context = {
      agent: minimalAgent(["session"]),
      sessionId: "s1",
    };

    expect(
      bridge.executeTool(
        {
          toolName: "list_memory_index",
          arguments: { scope: "session" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: "# Session Memory",
    });
    expect(
      bridge.executeTool(
        {
          toolName: "read_memory_entry",
          arguments: { scope: "session", file_name: "fact_alpha.md" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: "alpha body\n",
      metadata: {
        scope: "session",
      },
    });
  });

  it("exposes and executes read_file when enabled by agent config", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-alpha");
    writeAbsoluteFile(path.join(workspaceRoot, "notes", "sample.txt"), "line 1\nline 2\nline 3\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["read_file"]);

    expect(bridge.listVisibleToolNames(agent)).toEqual(["read_file"]);
    expect(
      bridge.executeTool(
        {
          toolName: "read_file",
          arguments: { file_path: "notes/sample.txt", offset: 2, limit: 1 },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).toMatchObject({
      success: true,
      tool_name: "read_file",
      content: "line 2",
      metadata: {
        total_lines: 3,
        start_line: 2,
        end_line: 2,
        has_more: true,
        next_offset: 3,
      },
    });
  });

  it("previews JSON, CSV, YAML, and text structures through managed paths", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-preview");
    writeAbsoluteFile(
      path.join(workspaceRoot, "data", "sample.json"),
      '{"name":"dataset","items":[{"id":1,"tags":["a","b"],"meta":{"city":"Nanning"}}]}',
    );
    writeAbsoluteFile(path.join(workspaceRoot, "data", "sample.csv"), "name,age,active\nAlice,30,true\nBob,28,false\n");
    writeAbsoluteFile(path.join(workspaceRoot, "data", "sample.yaml"), "service:\n  name: api\n  replicas: 3\nfeatures:\n  - search\n  - export\n");
    writeAbsoluteFile(path.join(workspaceRoot, "data", "notes.txt"), "alpha\n\nbeta line\ncharlie\n");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["preview_data_structure"]);
    const context = {
      agent,
      sessionId: "s1",
      workspaceRoot,
    };

    expect(bridge.listVisibleToolNames(agent)).toEqual(["preview_data_structure"]);
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/sample.json" },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "preview_data_structure",
      output_type: "json",
      content: {
        file_type: "json",
        structure: {
          type: "object",
          fields: {
            name: { type: "string" },
            items: {
              type: "array",
              item_structure: {
                fields: {
                  id: { types: ["integer"] },
                },
              },
            },
          },
        },
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/sample.csv", max_preview_rows: 1 },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "csv",
        structure: {
          root_type: "table",
          columns: ["name", "age", "active"],
          sample_row_count: 1,
          column_types: {
            age: { types: ["integer"] },
            active: { types: ["boolean"] },
          },
          sample_rows: [
            {
              name: "Alice",
            },
          ],
        },
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/sample.yaml", max_depth: 2 },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "yaml",
        structure: {
          type: "object",
          fields: {
            service: { type: "object" },
            features: { type: "array" },
          },
        },
      },
    });
    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "data/notes.txt", max_preview_rows: 2 },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      content: {
        file_type: "txt",
        structure: {
          root_type: "text",
          total_lines: 4,
          non_empty_lines: 3,
          preview_lines: ["alpha", ""],
        },
      },
    });
  });

  it("rejects invalid preview_data_structure limits", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-preview-invalid");
    writeAbsoluteFile(path.join(workspaceRoot, "sample.json"), "{}");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["preview_data_structure"]);

    expect(
      bridge.executeTool(
        {
          toolName: "preview_data_structure",
          arguments: { file_path: "sample.json", max_depth: 0 },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: expect.stringContaining("max_depth"),
    });
  });

  it("executes write_file and edit_file through managed workspace paths", () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-beta");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      new LocalDocumentToolService({ dataRoot }),
    );
    const agent = minimalAgent([], ["write_file", "edit_file"]);
    const context = {
      agent,
      sessionId: "s1",
      workspaceRoot,
    };

    expect(bridge.listVisibleToolNames(agent)).toEqual(["write_file", "edit_file"]);
    expect(
      bridge.executeTool(
        {
          toolName: "write_file",
          arguments: {
            file_path: "notes/todo.txt",
            content: "before\n",
          },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "write_file",
      content: {
        display_path: expect.stringContaining("notes/todo.txt"),
      },
    });

    expect(
      bridge.executeTool(
        {
          toolName: "edit_file",
          arguments: {
            file_path: "notes/todo.txt",
            old_string: "before",
            new_string: "after",
          },
        },
        context,
      ),
    ).toMatchObject({
      success: true,
      tool_name: "edit_file",
      content: {
        replacements: 1,
        diff_preview: expect.stringContaining("-before"),
      },
    });
    expect(fs.readFileSync(path.join(workspaceRoot, "notes", "todo.txt"), "utf8")).toBe("after\n");
  });

  it("exposes and executes execute_bash when enabled by agent config", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    expect(bridge.listVisibleToolNames(agent)).toEqual(["execute_bash"]);
    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "echo hello",
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      content: {
        stdout: expect.stringContaining("hello"),
        return_code: 0,
        interrupted: false,
        background_started: false,
        classification: "read_only",
      },
      metadata: {
        classification: "read_only",
        risk_level: "low",
      },
    });
  });

  it("blocks unsafe execute_bash command syntax before approval", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-block");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      null,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "echo $(whoami)",
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).resolves.toMatchObject({
      success: false,
      tool_name: "execute_bash",
      content: expect.stringContaining("命令安全检查失败"),
    });
  });

  it("asks for approval before execute_bash write commands", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-approval");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const events = new InMemoryEventBus();
    const pendingInteractions = new PendingInteractionService(events);
    const permissionPolicy = new PermissionPolicyService();
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      pendingInteractions,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          callId: "bash-approval-call",
          arguments: {
            command: "mkdir created_dir",
            description: "create a test directory",
          },
        },
        {
          agent,
          sessionId: "s1",
          runId: "run-bash-approval",
          taskId: "task-bash-approval",
          requestId: "req-bash-approval",
          workspaceRoot,
        },
      ),
    );

    const approvalRequired = events.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      approval_type: "bash_command",
      tool_call_id: "bash-approval-call",
      tool_name: "execute_bash",
      risk_level: "medium",
      approval_reason: "当前策略要求人工审批",
      arguments: expect.objectContaining({
        command: "mkdir created_dir",
        command_segments: ["mkdir"],
        classification: "write",
      }),
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许创建目录",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      metadata: {
        approval_required_commands: ["mkdir"],
        approval_message: "允许创建目录",
        approval: {
          reason: "当前策略要求人工审批",
          note: "允许创建目录",
        },
      },
    });
    expect(fs.existsSync(path.join(workspaceRoot, "created_dir"))).toBe(true);
  });

  it("terminates execute_bash when timeout is reached", async () => {
    const dataRoot = makeTempDataRoot();
    const workspaceRoot = path.join(dataRoot, "workspace-bash-timeout");
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("dangerously_skip_permissions");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: { workspace_root: workspaceRoot } })),
      null,
      permissionPolicy,
      null,
      new LocalBashToolService({ dataRoot, bashExecutable: null }),
    );
    const agent = minimalAgent([], ["execute_bash"]);

    await expect(
      bridge.executeTool(
        {
          toolName: "execute_bash",
          arguments: {
            command: "node -e \"setTimeout(function(){}, 2000)\"",
            timeout: 1,
          },
        },
        {
          agent,
          sessionId: "s1",
          workspaceRoot,
        },
      ),
    ).resolves.toMatchObject({
      success: true,
      tool_name: "execute_bash",
      summary: expect.stringContaining("命令执行超时"),
      content: {
        interrupted: true,
      },
      metadata: {
        classification: "interpreter",
        risk_level: "high",
      },
    });
  });

  it("rejects tools that are not visible for the current agent", () => {
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
    );

    expect(
      bridge.executeTool(
        {
          toolName: "write_memory",
          arguments: {},
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
        },
      ),
    ).toMatchObject({
      success: false,
      output_type: "error",
      content: "工具未暴露或暂未迁移: write_memory",
    });
  });

  it("runs request_user_input through pending user input interactions", async () => {
    const events = new InMemoryEventBus();
    const pendingInteractions = new PendingInteractionService(events);
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({})),
      pendingInteractions,
    );

    expect(bridge.listVisibleToolNames(minimalAgent([]))).toEqual(["request_user_input"]);

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "request_user_input",
          callId: "input-call-1",
          arguments: {
            prompt: "使用哪个 memory scope？",
            input_type: "select",
            options: ["session", "workspace"],
          },
        },
        {
          agent: minimalAgent([]),
          sessionId: "s1",
          runId: "run-1",
          taskId: "task-1",
          requestId: "req-1",
          currentAgentName: "orchestrator_agent",
        },
      ),
    );

    const interactionRequired = events.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(interactionRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "user_input",
      input_id: expect.any(String),
      tool_call_id: "input-call-1",
      tool_name: "request_user_input",
      prompt: "使用哪个 memory scope？",
      input_type: "select",
      options: ["session", "workspace"],
      run_id: "run-1",
      task_id: "task-1",
      request_id: "req-1",
    });

    const inputRequired = events.getHistory("s1").find((event) => event.type === "user.input_required");
    expect(inputRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "user_input",
      input_id: expect.any(String),
      tool_call_id: "input-call-1",
      tool_name: "request_user_input",
      prompt: "使用哪个 memory scope？",
      input_type: "select",
      options: ["session", "workspace"],
      run_id: "run-1",
      task_id: "task-1",
      request_id: "req-1",
    });

    const inputId = (inputRequired?.data as { input_id: string }).input_id;
    expect((interactionRequired?.data as { interaction_id: string }).interaction_id).toBe(inputId);
    expect(bridge.listVisibleToolNames(minimalAgent(["session"]))).toEqual([
      "request_user_input",
      "list_memory_index",
      "read_memory_entry",
    ]);
    expect(inputId).toBeTruthy();
    expect(pendingInteractions.isUserInputPending("s1", inputId)).toBe(true);
    expect(pendingInteractions.respondUserInput("s1", inputId, { value: "session" })).toBe(true);

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "request_user_input",
      summary: "用户输入已接收",
      content: "session",
      metadata: {
        input_id: inputId,
        input_type: "select",
        options: ["session", "workspace"],
        degraded: false,
      },
    });
  });

  it("waits for approval before executing tools when policy asks", async () => {
    const dataRoot = makeTempDataRoot();
    writeFile(dataRoot, ["memory", "sessions", "s1", "MEMORY.md"], "# Approved Memory\n");
    const events = new InMemoryEventBus();
    const pendingInteractions = new PendingInteractionService(events);
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("strict");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot }), new InMemorySessions({ s1: {} })),
      pendingInteractions,
      permissionPolicy,
    );

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "list_memory_index",
          callId: "approval-call-1",
          arguments: { scope: "session" },
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
          runId: "run-approval-1",
          taskId: "task-approval-1",
          requestId: "req-approval-1",
          currentAgentName: "orchestrator_agent",
        },
      ),
    );

    const approvalRequired = events.getHistory("s1").find((event) => event.type === "interaction.required");
    expect(approvalRequired?.data).toMatchObject({
      interaction_id: expect.any(String),
      kind: "approval",
      approval_id: expect.any(String),
      approval_type: "tool_execution",
      tool_call_id: "approval-call-1",
      tool_name: "list_memory_index",
      risk_level: "low",
      permission_mode: "strict",
      approval_reason: "严格模式：low 风险工具需要审批",
      approval_reason_codes: ["ask-risk"],
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    expect(pendingInteractions.isApprovalPending("s1", approvalId)).toBe(true);
    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: true,
        message: "允许读取",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: true,
      tool_name: "list_memory_index",
      content: "# Approved Memory",
      metadata: {
        approval_message: "允许读取",
        approval: {
          reason: "严格模式：low 风险工具需要审批",
          note: "允许读取",
          reason_codes: ["ask-risk"],
        },
      },
    });
  });

  it("returns a tool error when approval is denied", async () => {
    const events = new InMemoryEventBus();
    const pendingInteractions = new PendingInteractionService(events);
    const permissionPolicy = new PermissionPolicyService();
    permissionPolicy.setMode("strict");
    const bridge = new RuntimeToolBridge(
      new MemoryToolService(new MemoryStore({ dataRoot: makeTempDataRoot() }), new InMemorySessions({ s1: {} })),
      pendingInteractions,
      permissionPolicy,
    );

    const resultPromise = Promise.resolve(
      bridge.executeTool(
        {
          toolName: "list_memory_index",
          callId: "approval-call-deny",
          arguments: { scope: "session" },
        },
        {
          agent: minimalAgent(["session"]),
          sessionId: "s1",
        },
      ),
    );
    const approvalRequired = events.getHistory("s1").find((event) => event.type === "interaction.required");
    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;

    expect(
      pendingInteractions.respondInteraction("s1", approvalId, {
        kind: "approval",
        approved: false,
        message: "不允许",
      }),
    ).toMatchObject({
      resolved: true,
      kind: "approval",
    });

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      output_type: "error",
      content: "工具 list_memory_index 执行已被拒绝：不允许",
      metadata: {
        approval: {
          reason: "严格模式：low 风险工具需要审批",
          note: "不允许",
          reason_codes: ["ask-risk"],
        },
      },
    });
  });
});

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-runtime-tool-"));
  tempRoots.push(root);
  return root;
}

function writeFile(dataRoot: string, parts: string[], content: string): void {
  const filePath = path.join(dataRoot, ...parts);
  writeAbsoluteFile(filePath, content);
}

function writeAbsoluteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function minimalAgent(allowedScopes: string[], enabledTools: string[] = []): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator Agent",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        extra_params: {},
      },
    },
    tools: { enabled_tools: enabledTools },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: allowedScopes,
      write_scopes: [],
      archive_scopes: [],
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {},
  };
}
