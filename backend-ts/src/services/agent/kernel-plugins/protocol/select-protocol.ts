/**
 * 协议选择器（kernel-plugins/protocol）。
 *
 * 阶段一（本文件）退化为恒返回 XmlProtocol：
 * - 现状“有工具 / 无工具”不是两种协议，而是同一套 XML 内容协议 + 同一个
 *   StreamingRuntimeXmlParser 的两种 outcome（有 <tool_calls> ⇒ 工具态，无 ⇒ final 态）。
 *   统一成一个 XmlProtocol 即连根拔除重复（见 docs/kernel-refactor-phase1.md 二节关键边界）。
 * - 现状两条非流式分支（runToolCallingText 原生 FC、completeRequest 非流式补全）由同一
 *   `!stream` 条件把守，生产 llmChatClient.stream 恒存在 ⇒ 均为死代码，已删除不迁移，
 *   也不并入任何协议。故阶段一无 native-fc 协议。
 *
 * 签名预留（阶段二才真正分派）：
 * - 阶段二 selectProtocol 将按 provider_type + supports_function_calling 分派到
 *   OpenAiHybridProtocol / AnthropicHybridProtocol / XmlProtocol 之一。
 * - 现状 shouldRunXmlToolLoop 从不读 supports_function_calling（fc 能力被忽略、强制走 XML），
 *   该缺陷在阶段二修正——故此处阶段一只预留参数，不做任何判断。
 *
 * 入参含义（为阶段二对齐）：
 * - provider：ModelProviderConfig，阶段二读其 provider_type。
 * - llmChatClient：流式请求执行器，注入给具体 Protocol。
 * - events：EventSink，Protocol 内部发 delta / first_token / intent_* 等事件用。
 * - supportsFunctionCallings：阶段二 fc 能力探测结果；阶段一忽略。
 */

import type { LlmChatClient } from "../../../integrations/llm-chat-client.js";
import type { ModelProviderConfig } from "../../../../contracts/model-adapter.js";
import type { EventSink, Protocol } from "../../kernel/contracts.js";
import { XmlProtocol } from "./xml-protocol.js";

export interface SelectProtocolDeps {
  provider: ModelProviderConfig;
  llmChatClient: LlmChatClient;
  events: EventSink;
  /**
   * 各模型的 function-calling 能力探测结果（键 = model name）。
   * 阶段一未使用，仅为阶段二预留签名；类型宽松以容纳未来探测表形态。
   */
  supportsFunctionCallings?: Record<string, boolean> | undefined;
}

/**
 * 阶段一：恒返回 XmlProtocol 实例。
 *
 * 阶段二：改写为按 provider_type + supports_function_calling 分派（见上方注释）。
 */
export function selectProtocol(deps: SelectProtocolDeps): Protocol {
  // 阶段一退化为恒返回 XmlProtocol——deps 暂不参与选择，仅作签名预留。
  // 显式 void 引用，表明“阶段一故意忽略 provider/supportsFunctionCallings”，避免 lint unused 误报，
  // 同时把阶段二要用的入参钉死在签名上。
  void deps.provider;
  void deps.supportsFunctionCallings;

  // XmlProtocol 构造为位置参数（llmChatClient, eventSink），与 xml-protocol.ts 对齐。
  return new XmlProtocol(deps.llmChatClient, deps.events);
}
