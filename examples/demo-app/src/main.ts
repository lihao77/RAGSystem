/**
 * demo 闭环：connect → enableDelegation → registerTool → onToolCall
 *           → 喂投影链 tool_call/tool_result → 验证 executionTree
 *           → 喂委托 tool_call(request) → 验证 handler 被触发
 */
import { MockAgentSDK } from "./mock-sdk.js";

async function main(): Promise<void> {
  const sdk = new MockAgentSDK();
  await sdk.connect({ url: "mock://session-1" });
  console.log("[demo] connected, status =", sdk.status.get().state);

  sdk.enableDelegation();
  sdk.registerTool({
    name: "echo",
    description: "echo the input text",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    riskLevel: "low",
    async execute(input) {
      const text = (input as { text?: string } | null)?.text ?? "";
      return { ok: true, observation: `echo: ${text}` };
    },
  });

  let delegatedInvoked = false;
  sdk.onToolCall(async (req) => {
    delegatedInvoked = true;
    console.log(`[demo] delegated tool_call received: ${req.toolName}`);
    return { ok: true, observation: `delegated:${req.toolName}` };
  });

  // —— 投影链：agent_started → stream_output(intent) → tool_call → tool_result ——
  sdk.feedMock({
    type: "agent_started",
    session_id: "session-1",
    run_id: "run-1",
    call_id: "root-1",
    agent_id: "orchestrator",
    payload: { phase: "start", task: "list files" },
  });
  sdk.feedMock({
    type: "stream_output",
    session_id: "session-1",
    run_id: "run-1",
    call_id: "root-1",
    payload: { phase: "intent_complete", content: "I will list files", round: 1 },
  });
  sdk.feedMock({
    type: "tool_call",
    session_id: "session-1",
    run_id: "run-1",
    call_id: "call-1",
    payload: {
      tool: "execute_bash",
      phase: "start",
      mode: "projection",
      input: { cmd: "ls" },
      lineage: { parent_call_id: "root-1" },
    },
  });
  sdk.feedMock({
    type: "tool_result",
    session_id: "session-1",
    run_id: "run-1",
    call_id: "call-1",
    payload: { tool: "execute_bash", phase: "end", mode: "projection", ok: true, observation: "file.txt" },
  });

  const tree = sdk.executionTree.get();
  const root = tree.root;
  const tool = root?.rounds[0]?.toolCalls[0];
  const projectionOk =
    root?.agentId === "orchestrator"
    && root.rounds[0]?.intent === "I will list files"
    && tool?.toolName === "execute_bash"
    && tool?.status === "succeeded";
  console.log(
    `[demo] executionTree: rootAgent=${root?.agentId} rounds=${root?.rounds.length} toolStatus=${tool?.status}`,
  );
  console.assert(projectionOk, "executionTree projection FAILED");

  // —— 委托路径：tool_call(delegation, request) 触发宿主 handler ——
  sdk.feedMock({
    type: "tool_call",
    session_id: "session-1",
    run_id: "run-1",
    call_id: "call-2",
    payload: { tool: "echo", phase: "request", mode: "delegation", input: { text: "hi" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  console.log(`[demo] delegated handler invoked: ${delegatedInvoked}`);
  console.assert(delegatedInvoked, "delegation handler NOT invoked");

  if (!projectionOk || !delegatedInvoked) {
    console.error("[demo] FAILED");
    process.exit(1);
  }
  console.log("[demo] OK: tool_call→tool_result projected, delegate path armed");
}

main().catch((err) => {
  console.error("[demo] FAILED:", err);
  process.exit(1);
});
