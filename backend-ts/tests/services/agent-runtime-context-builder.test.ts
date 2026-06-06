import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { RunStepInfo } from "../../src/contracts/common.js";
import type { MessageInfo } from "../../src/contracts/session.js";
import {
  AgentRuntimeContextBuilder,
  EmptyMemoryContextSource,
  MemoryIndexContextSource,
  RecentMessagesContextSource,
  type AgentRuntimeContextSource,
  type RuntimeConversationHistoryPort,
  type RuntimeSessionMetadataPort,
} from "../../src/services/agent-runtime-context-builder.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class InMemoryHistory implements RuntimeConversationHistoryPort {
  readonly calls: Array<{ sessionId: string; limit: number | undefined; threadKey: string | null | undefined }> = [];

  constructor(private readonly messages: MessageInfo[], private readonly runSteps: RunStepInfo[] = []) {}

  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[] {
    this.calls.push({ sessionId, limit, threadKey });
    return this.messages.slice(0, limit);
  }

  listRunSteps(input: { runId?: string | null; sessionId?: string | null; limit?: number }): RunStepInfo[] {
    return this.runSteps
      .filter((step) => (!input.runId || step.run_id === input.runId) && (!input.sessionId || step.session_id === input.sessionId))
      .slice(0, input.limit ?? this.runSteps.length);
  }
}

class InMemorySessions implements RuntimeSessionMetadataPort {
  constructor(private readonly metadata: Record<string, unknown>) {}

  getSession() {
    return { metadata: this.metadata };
  }
}

describe("AgentRuntimeContextBuilder", () => {
  it("builds minimal runtime conversation from recent root user, assistant, and system messages", () => {
    const history = new InMemoryHistory([
      message("user", "hello"),
      message("assistant", "hi"),
      message("system", "runtime note"),
      message("tool", "tool result"),
    ]);
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "s1" });

    expect(history.calls).toEqual([{ sessionId: "s1", limit: 20, threadKey: "root" }]);
    expect(context).toEqual({
      conversation: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "system", content: "runtime note" },
      ],
      metadata: {
        session_id: "s1",
        thread_key: "root",
        history_limit: 20,
        sources: [
          {
            name: "recent_messages",
            message_count: 3,
            metadata: {
              source_message_count: 4,
              filtered_message_count: 3,
              resolved_message_count: 3,
              compression_view: {
                applied: false,
                summary_seq: null,
                replaces_up_to_seq: null,
              },
            },
          },
        ],
      },
    });
  });

  it("resolves persisted compression summaries before building runtime conversation", () => {
    const history = new InMemoryHistory([
      message("user", "u1", { seq: 1 }),
      message("assistant", "a1", { seq: 2 }),
      message("user", "tail-before-summary", { seq: 3 }),
      message("system", "[历史摘要]\nsummary", {
        seq: 4,
        metadata: {
          compression: true,
          replaces_up_to_seq: 2,
        },
      }),
      message("assistant", "tail-after-summary", { seq: 5 }),
    ]);
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "compression-session" });

    expect(context.conversation).toEqual([
      { role: "assistant", content: "[历史摘要]\nsummary" },
      { role: "user", content: "tail-before-summary" },
      { role: "assistant", content: "tail-after-summary" },
    ]);
    expect(context.metadata.sources).toEqual([
      {
        name: "recent_messages",
        message_count: 3,
        metadata: {
          source_message_count: 5,
          filtered_message_count: 5,
          resolved_message_count: 3,
          compression_view: {
            applied: true,
            summary_seq: 4,
            replaces_up_to_seq: 2,
          },
        },
      },
    ]);
  });

  it("filters persisted history with Python-compatible agent context visibility", () => {
    const history = new InMemoryHistory([
      message("user", "/review demo", { seq: 1, metadata: { type: "command" } }),
      message("system", "command result", { seq: 2, metadata: { type: "command_result" } }),
      message("user", "/review demo", { seq: 3, metadata: { display_only: true } }),
      message("user", "expanded review prompt", { seq: 4 }),
      message("assistant", "[interrupted]", { seq: 5, metadata: { interrupted: true } }),
      message("system", "[Request interrupted by user]", { seq: 6, metadata: { hidden: true, interrupted: true } }),
      message("assistant", "thought", { seq: 7, metadata: { react_intermediate: true } }),
      message("system", "runtime instruction", { seq: 8 }),
      message("tool", "native tool result", { seq: 9 }),
      message("assistant", "final", { seq: 10 }),
    ]);
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "visibility-session" });

    expect(context.conversation).toEqual([
      { role: "user", content: "expanded review prompt" },
      { role: "assistant", content: "thought" },
      { role: "system", content: "runtime instruction" },
      { role: "assistant", content: "final" },
    ]);
    expect(context.metadata.sources).toEqual([
      {
        name: "recent_messages",
        message_count: 4,
        metadata: {
          source_message_count: 10,
          filtered_message_count: 4,
          resolved_message_count: 4,
          compression_view: {
            applied: false,
            summary_seq: null,
            replaces_up_to_seq: null,
          },
        },
      },
    ]);
  });

  it("expands assistant run steps into Python-compatible ReAct history", () => {
    const history = new InMemoryHistory(
      [
        message("user", "测试工具", { seq: 1, metadata: { run_id: "run-1" } }),
        message("assistant", "工具测试完成", { seq: 2, metadata: { run_id: "run-1" } }),
      ],
      [
        runStep("run-1", 1, {
          kind: "tool",
          phase: "start",
          tool_name: "execute_bash",
          arguments: { command: "pwd" },
          round: 1,
        }),
        runStep("run-1", 2, {
          kind: "tool",
          phase: "end",
          tool_name: "execute_bash",
          observation: "[execute_bash]\n命令执行完成，返回码 0",
          round: 1,
        }),
      ],
    );
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "s1" });

    expect(context.conversation).toEqual([
      { role: "user", content: "测试工具" },
      {
        role: "assistant",
        content: "<tools>\n<tool name=\"execute_bash\">\n<command>pwd</command>\n</tool>\n</tools>",
      },
      { role: "user", content: "[execute_bash]\n命令执行完成，返回码 0" },
      { role: "assistant", content: "工具测试完成" },
    ]);
    expect(context.metadata.sources[0]).toMatchObject({
      name: "recent_messages",
      message_count: 4,
      metadata: {
        source_message_count: 2,
        filtered_message_count: 2,
        resolved_message_count: 4,
      },
    });
  });

  it("merges same-round synthetic observations and keeps result steps in the tool start round", () => {
    const history = new InMemoryHistory(
      [
        message("user", "连续测试工具", { seq: 1, metadata: { run_id: "run-1" } }),
        message("assistant", "测试完成", { seq: 2, metadata: { run_id: "run-1" } }),
      ],
      [
        runStep("run-1", 1, {
          kind: "intent",
          phase: "complete",
          content: "先执行 pwd。",
          round: 0,
        }),
        runStep("run-1", 2, {
          kind: "tool",
          phase: "start",
          call_id: "call-1",
          tool_name: "execute_bash",
          arguments: { command: "pwd" },
          round: 0,
        }),
        runStep("run-1", 3, {
          kind: "tool",
          phase: "end",
          call_id: "call-1",
          tool_name: "execute_bash",
          summary: "命令执行完成，返回码 0",
        }),
        runStep("run-1", 4, {
          kind: "tool",
          phase: "start",
          call_id: "call-1b",
          tool_name: "task_list",
          arguments: {},
          round: 0,
        }),
        runStep("run-1", 5, {
          kind: "tool",
          phase: "end",
          call_id: "call-1b",
          tool_name: "task_list",
          summary: "共 0 个任务",
        }),
        runStep("run-1", 6, {
          kind: "tool",
          phase: "start",
          call_id: "call-2",
          tool_name: "read_file",
          arguments: {},
          round: 1,
        }),
        runStep("run-1", 7, {
          kind: "tool",
          phase: "end",
          call_id: "call-2",
          tool_name: "read_file",
          summary: "文件读取成功",
        }),
      ],
    );
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "s1" });

    expect(context.conversation).toEqual([
      { role: "user", content: "连续测试工具" },
      {
        role: "assistant",
        content:
          "先执行 pwd。\n\n<tools>\n<tool name=\"execute_bash\">\n<command>pwd</command>\n</tool>\n<tool name=\"task_list\">\n</tool>\n</tools>",
      },
      { role: "user", content: "[execute_bash]\n命令执行完成，返回码 0\n\n[task_list]\n共 0 个任务" },
      {
        role: "assistant",
        content: "<tools>\n<tool name=\"read_file\">\n</tool>\n</tools>",
      },
      { role: "user", content: "[read_file]\n文件读取成功" },
      { role: "assistant", content: "测试完成" },
    ]);
  });

  it("orders synthetic tool history by action order when run steps are persisted out of order", () => {
    const history = new InMemoryHistory(
      [
        message("user", "并发工具", { seq: 1, metadata: { run_id: "run-1" } }),
        message("assistant", "并发完成", { seq: 2, metadata: { run_id: "run-1" } }),
      ],
      [
        runStep("run-1", 1, {
          kind: "tool",
          phase: "start",
          call_id: "call-2",
          tool_name: "seed_file",
          arguments: {},
          round: 0,
          order: 2,
          round_index: 2,
        }),
        runStep("run-1", 2, {
          kind: "tool",
          phase: "start",
          call_id: "call-1",
          tool_name: "read_file",
          arguments: { file_path: "{result_2.content.file_path}" },
          round: 0,
          order: 1,
          round_index: 1,
        }),
        runStep("run-1", 3, {
          kind: "tool",
          phase: "end",
          call_id: "call-2",
          tool_name: "seed_file",
          observation: "[seed_file]\nseeded",
          order: 2,
          round_index: 2,
        }),
        runStep("run-1", 4, {
          kind: "tool",
          phase: "end",
          call_id: "call-1",
          tool_name: "read_file",
          observation: "[read_file]\nread ok",
          order: 1,
          round_index: 1,
        }),
      ],
    );
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "s1" });

    expect(context.conversation).toEqual([
      { role: "user", content: "并发工具" },
      {
        role: "assistant",
        content:
          "<tools>\n<tool name=\"read_file\">\n<file_path>{result_2.content.file_path}</file_path>\n</tool>\n<tool name=\"seed_file\">\n</tool>\n</tools>",
      },
      { role: "user", content: "[read_file]\nread ok\n\n[seed_file]\nseeded" },
      { role: "assistant", content: "并发完成" },
    ]);
  });

  it("supports explicit thread key and history limit", () => {
    const history = new InMemoryHistory([message("user", "child hello"), message("assistant", "child answer")]);
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({
      sessionId: "s2",
      threadKey: "child:worker",
      historyLimit: 1,
    });

    expect(history.calls).toEqual([{ sessionId: "s2", limit: 1, threadKey: "child:worker" }]);
    expect(context).toMatchObject({
      conversation: [{ role: "user", content: "child hello" }],
      metadata: {
        session_id: "s2",
        thread_key: "child:worker",
        history_limit: 1,
        sources: [
          {
            name: "recent_messages",
            message_count: 1,
          },
        ],
      },
    });
  });

  it("combines context source contributions in declaration order", () => {
    const history = new InMemoryHistory([message("user", "hello")]);
    const syntheticSource: AgentRuntimeContextSource = {
      name: "synthetic",
      build: () => ({
        conversation: [{ role: "assistant", content: "synthetic context" }],
        metadata: { mode: "test" },
      }),
    };
    const builder = new AgentRuntimeContextBuilder([
      new RecentMessagesContextSource(history),
      syntheticSource,
      new EmptyMemoryContextSource(),
    ]);

    const context = builder.buildContext({ sessionId: "s3" });

    expect(context.conversation).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "synthetic context" },
    ]);
    expect(context.metadata.sources).toEqual([
      expect.objectContaining({ name: "recent_messages", message_count: 1 }),
      {
        name: "synthetic",
        message_count: 1,
        metadata: { mode: "test" },
      },
      {
        name: "memory",
        message_count: 0,
        metadata: { status: "not_loaded" },
      },
    ]);
  });

  it("loads Python-compatible memory indices from the shared data root", () => {
    const dataRoot = makeTempDataRoot();
    writeMemoryIndex(dataRoot, ["teams", "alpha-team"], "# Team Memory\n");
    writeMemoryIndex(dataRoot, ["sessions", "s4"], "# Session Memory\n");
    writeMemoryIndex(dataRoot, ["teams", "alpha-team", "agents", "chart_agent"], "# Agent Memory\n");
    writeMemoryIndex(
      dataRoot,
      ["workspaces", "E-Python-RAGSystem-workspaces-demo-workspace"],
      "# Workspace Memory\n",
    );
    const sessions = new InMemorySessions({
      team: "alpha-team",
      workspace_root: "E:/Python/RAGSystem/workspaces/demo-workspace",
    });
    const builder = new AgentRuntimeContextBuilder([
      new MemoryIndexContextSource(sessions, {
        dataRoot,
      }),
    ]);

    const context = builder.buildContext({
      sessionId: "s4",
      agent: minimalAgent({
        agentName: "chart_agent",
        allowedScopes: ["team", "session", "agent", "workspace"],
      }),
    });

    expect(context.conversation).toHaveLength(1);
    expect(context.conversation[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("[Memory Scope Capabilities]"),
    });
    expect(context.conversation[0]?.content).toContain("[Team Memory Index]\n# Team Memory");
    expect(context.conversation[0]?.content).toContain("[Session Memory Index]\n# Session Memory");
    expect(context.conversation[0]?.content).toContain("[Agent Memory Index]\n# Agent Memory");
    expect(context.conversation[0]?.content).toContain("[Workspace Memory Index]\n# Workspace Memory");
    expect(context.metadata.sources).toEqual([
      {
        name: "memory",
        message_count: 1,
        metadata: {
          status: "loaded",
          snapshot: expect.objectContaining({
            baseline_key: "root::chart_agent",
            session_id: "s4",
            thread_key: "root",
            agent_name: "chart_agent",
            scope_capabilities: {
              allowed_scopes: ["team", "session", "agent", "workspace"],
              write_scopes: ["session"],
              archive_scopes: ["session"],
            },
            indices: {
              team: "# Team Memory",
              session: "# Session Memory",
              agent: "# Agent Memory",
              workspace: "# Workspace Memory",
            },
            fingerprint: expect.objectContaining({
              fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
            }),
          }),
        },
      },
    ]);
  });

  it("can expose memory capabilities without auto-injecting memory indices", () => {
    const dataRoot = makeTempDataRoot();
    writeMemoryIndex(dataRoot, ["sessions", "s5"], "# Session Memory\n");
    const builder = new AgentRuntimeContextBuilder([
      new MemoryIndexContextSource(new InMemorySessions({}), {
        dataRoot,
      }),
    ]);

    const context = builder.buildContext({
      sessionId: "s5",
      agent: minimalAgent({
        agentName: "chart_agent",
        autoInject: false,
        allowedScopes: ["session"],
      }),
    });

    expect(context.conversation).toEqual([
      {
        role: "system",
        content: expect.stringContaining("[Memory Scope Capabilities]"),
      },
    ]);
    expect(context.conversation[0]?.content).not.toContain("# Session Memory");
    expect(context.metadata.sources[0]?.metadata).toMatchObject({
      status: "loaded",
      snapshot: {
        indices: {},
      },
    });
  });
});

function message(
  role: MessageInfo["role"],
  content: string,
  input: {
    seq?: number;
    metadata?: Record<string, unknown>;
    threadKey?: string;
  } = {},
): MessageInfo {
  return {
    seq: input.seq ?? 1,
    id: `${role}-${content}`,
    session_id: "s1",
    role,
    content,
    metadata: input.metadata ?? {},
    thread_key: input.threadKey ?? "root",
    child_agent_id: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function runStep(runId: string, order: number, payload: Record<string, unknown>): RunStepInfo {
  return {
    id: order,
    run_id: runId,
    session_id: "s1",
    message_id: "assistant-1",
    step_order: order,
    step_type: "execution.step",
    payload,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-runtime-context-"));
  tempRoots.push(root);
  return root;
}

function writeMemoryIndex(dataRoot: string, scopeParts: string[], content: string): void {
  const filePath = path.join(dataRoot, "memory", ...scopeParts, "MEMORY.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function minimalAgent(input: {
  agentName: string;
  allowedScopes: string[];
  autoInject?: boolean;
}): AgentConfig {
  return {
    agent_name: input.agentName,
    display_name: input.agentName,
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
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: input.autoInject ?? true,
      allowed_scopes: input.allowedScopes,
      write_scopes: ["session"],
      archive_scopes: ["session"],
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
