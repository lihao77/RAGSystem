export {
  parseRuntimeToolCallsXml,
  type ParsedToolCall,
  type RuntimeToolCallParseResult,
} from "./tool-calls.js";
export {
  isSemanticTaggedContent,
  renderNativeXmlProtocolInstruction,
  renderProtocolFeedbackMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  escapeXmlAttribute,
} from "./rendering.js";
export {
  StreamingRuntimeXmlParser,
  type RuntimeXmlParseEvent,
  type RuntimeXmlTag,
} from "./streaming-parser.js";
export { serializeToolCallsToXml } from "./serialize.js";
