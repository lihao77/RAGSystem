/**
 * Agent 微内核 — per-run kernel 装配工厂。
 *
 * 为什么 per-run：EventSink（RuntimeEventSink）透传 per-run 的 publishRuntimeEvent，
 * 绑定当次 run 的 sessionId/runId/...；MessageRefresher 绑定当次会话的增量源；
 * 故 XmlProtocol / RuntimeToolProvider / AgentKernel 随每次 run 重新构造（对象无状态，
 * 开销可忽略）。container 只提供共享依赖 llmChatClient / dataRoot，run-engine 与
 * delegation 各自构造 eventSink / refresher / hooks 后调本工厂。
 *
 * - run-engine：RuntimeEventSink（透传 publishRuntimeEvent）+ 真 refresher + afterModel hook。
 * - delegation：NullEventSink（child 静默）+ noop refresher + afterModel hook。
 */

import type { LlmChatClient } from "../../integrations/llm-chat-client.js";
import type { EventSink, HookRegistry, MessageRefresher } from "../kernel/contracts.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import { AgentKernel } from "../kernel/agent-kernel.js";
import { RuntimeContext } from "./context/runtime-context.js";
import { selectProtocol } from "./protocol/select-protocol.js";
import { RuntimeToolProvider } from "./tools/runtime-tool-provider.js";

export interface RuntimeKernelDeps {
  llmChatClient: LlmChatClient;
  /** 阶段二 Phase 2.4 上提：selectProtocol 按其 provider_type + supports_function_calling 分派协议。 */
  provider: ModelProviderConfig;
  dataRoot: string;
  eventSink: EventSink;
  refresher: MessageRefresher;
  hooks: HookRegistry;
}

export function createRuntimeKernel(deps: RuntimeKernelDeps): AgentKernel {
  const { protocol, toolInstructionMode } = selectProtocol({
    provider: deps.provider,
    llmChatClient: deps.llmChatClient,
    events: deps.eventSink,
  });
  const context = new RuntimeContext({ toolInstructionMode });
  const tools = new RuntimeToolProvider({ dataRoot: deps.dataRoot, events: deps.eventSink });
  return new AgentKernel({
    context,
    protocol,
    tools,
    events: deps.eventSink,
    refresher: deps.refresher,
    hooks: deps.hooks,
  });
}
