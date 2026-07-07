/**
 * message 记录语义类型(msg_type)值域。
 *
 * 一条 message 的「记录类型」统一由 metadata.msg_type 表达:LLM 上下文过滤
 * (filterHistoryMessages)、压缩视图(resolveCompressionView)、前端渲染分派
 * (ChatMessageItem) 均按此判断,取代散落的 metadata.type / metadata.compression。
 *
 * 正交维度不在此列,仍留 metadata 各自字段:可见性(hidden/display_only/
 * visible_to_user)、来源(background_notification.source)、运行态(interrupted)。
 */
export const MSG_TYPE = {
  /** assistant 终态输出消息(completed final,含 interrupted 空占位)。 */
  ASSISTANT_FINAL: "assistant_final",
  /** tool_result——工具执行结果回灌(tool role)。 */
  OBSERVATION: "observation",
  /** assistant 中间轮次(含 tool_call 的 intent)。 */
  INTENT: "intent",
  /** 上下文压缩摘要(role=assistant 载体,历史按 replaces_up_to_seq 截断)。 */
  CONTEXT_COMPRESSION_SUMMARY: "context_compression_summary",
  /** user 侧斜杠命令;command_mode='prompt' 进 LLM,'system' 不进。 */
  COMMAND: "command",
  /** 系统对斜杠命令的应答(role=system 载体,不进 LLM)。 */
  COMMAND_RESULT: "command_result",
} as const;

export type MessageKind = (typeof MSG_TYPE)[keyof typeof MSG_TYPE];
