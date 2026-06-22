export {
  parseRuntimeToolCallsXml,
  type RuntimeToolCallParseResult,
} from "./tool-calls.js";
export {
  isSemanticTaggedContent,
  renderProtocolFeedbackMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  renderToolResultContent,
  renderToolResultMessage,
} from "./rendering.js";
export {
  StreamingRuntimeXmlParser,
  type RuntimeXmlParseEvent,
  type RuntimeXmlTag,
} from "./streaming-parser.js";
export { serializeToolCallsToXml } from "./serialize.js";
