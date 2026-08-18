/** LLM 协议模块公共导出（工具调用编码：XML/native 协议解析 + 自动选择）。 */
export { XmlProtocol } from "./xml-protocol.js";
export type { XmlProtocolDeps } from "./xml-protocol.js";
export { NativeHybridProtocol } from "./native-hybrid-protocol.js";
export type { NativeHybridProtocolDeps } from "./native-hybrid-protocol.js";
export { createProtocol, resolveToolInstructionMode } from "./select-protocol.js";
export type { ProtocolFactoryOptions, SelectedProtocol } from "./select-protocol.js";
export { renderXmlModelMessage, renderNativeModelMessage } from "./message-rendering.js";
export { sanitizeToolPairing } from "./tool-pairing.js";
export type { ToolPairingSanitizeResult } from "./tool-pairing.js";
export {
  StreamingRuntimeXmlParser,
  parseRuntimeToolCallsXml,
  serializeToolCallsToXml,
  renderRuntimeXmlProtocolInstruction,
  renderNativeXmlProtocolInstruction,
  renderProtocolFeedbackMessage,
  renderSemanticBlock,
  escapeXmlAttribute,
} from "./xml/index.js";
export type { RuntimeXmlTag, RuntimeXmlParseEvent, ParsedToolCall, RuntimeToolCallParseResult } from "./xml/index.js";
