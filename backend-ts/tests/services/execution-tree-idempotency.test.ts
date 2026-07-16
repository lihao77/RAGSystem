import { describe, expect, it } from "vitest";

import { buildExecutionTree, type Envelope } from "@ragsystem/agent-protocol";

const ROOT_CALL_ID = "call_root";
const TOOL_CALL_ID = "call_tool";

function agentStarted(): Envelope {
  return {
    type: "agent_started",
    session_id: "session-1",
    run_id: "run-1",
    call_id: ROOT_CALL_ID,
    agent_id: "orchestrator_agent",
    payload: { phase: "start", task: "write a file" },
  };
}

function toolCall(input: Record<string, unknown> = { file_path: "test.txt" }): Envelope {
  return {
    type: "tool_call",
    session_id: "session-1",
    run_id: "run-1",
    call_id: TOOL_CALL_ID,
    agent_id: "orchestrator_agent",
    payload: {
      tool: "write_file",
      input,
      phase: "start",
      status: "running",
      round: 0,
      lineage: { parent_call_id: ROOT_CALL_ID },
    },
  };
}

function toolResult(): Envelope {
  return {
    type: "tool_result",
    session_id: "session-1",
    run_id: "run-1",
    call_id: TOOL_CALL_ID,
    agent_id: "orchestrator_agent",
    payload: {
      tool: "write_file",
      phase: "end",
      ok: true,
      status: "succeeded",
      observation: "file written",
      lineage: { parent_call_id: ROOT_CALL_ID },
    },
  };
}

function projectedTool(events: Envelope[]) {
  const tree = buildExecutionTree(events);
  const tools = tree.root?.rounds.flatMap((round) => round.toolCalls) ?? [];
  return { tree, tools };
}

describe("execution-tree tool lifecycle idempotency", () => {
  it("projects approval resume start/start/result as one succeeded tool", () => {
    const { tools } = projectedTool([agentStarted(), toolCall(), toolCall(), toolResult()]);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      callId: TOOL_CALL_ID,
      toolName: "write_file",
      status: "succeeded",
      observation: "file written",
    });
  });

  it("does not regress a terminal tool when a duplicate start is replayed later", () => {
    const { tools } = projectedTool([agentStarted(), toolCall(), toolResult(), toolCall({ file_path: "changed.txt" })]);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      callId: TOOL_CALL_ID,
      status: "succeeded",
      arguments: { file_path: "test.txt" },
      observation: "file written",
    });
  });
});
