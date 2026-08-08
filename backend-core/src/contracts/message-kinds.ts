/**
 * message 记录语义类型(msg_type)值域。
 *
 * 一条运行消息的记录类型由 metadata.msg_type 表达。正文语义和 slash 命令统一由
 * content_parts 承载，不在 metadata 中建立第二套内容协议。
 *
 * 正交维度不在此列,仍留 metadata 各自字段:可见性(hidden/display_only/
 * visible_to_user)、来源(background_notification.source)、运行态(interrupted)。
 */
export const MSG_TYPE = {
  /** assistant 正常完成的终态输出消息。 */
  ASSISTANT_FINAL: "assistant_final",
  /** failed/interrupted Run 的非空终态消息，既是用户可见提示也是下一轮上下文边界。 */
  RUN_TERMINAL: "run_terminal",
  /** tool_result——工具执行结果回灌(tool role)。 */
  OBSERVATION: "observation",
  /** assistant 中间轮次(含 tool_call 的 intent)。 */
  INTENT: "intent",
  /** 上下文压缩摘要(role=assistant 载体,历史按 replaces_up_to_seq 截断)。 */
  CONTEXT_COMPRESSION_SUMMARY: "context_compression_summary",
} as const;

export type MessageKind = (typeof MSG_TYPE)[keyof typeof MSG_TYPE];
