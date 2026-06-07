export {
  parseRuntimeToolCallsXml,
  type RuntimeToolCallParseResult,
} from "./runtime-xml-protocol/tool-calls.js";
export {
  isSemanticTaggedContent,
  renderProtocolFeedbackMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  renderToolResultContent,
  renderToolResultMessage,
} from "./runtime-xml-protocol/rendering.js";
export {
  StreamingRuntimeXmlParser,
  type RuntimeXmlParseEvent,
  type RuntimeXmlTag,
} from "./runtime-xml-protocol/streaming-parser.js";
