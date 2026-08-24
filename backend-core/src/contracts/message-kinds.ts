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
  /**
   * assistant 运行轮次行（统一类型）：带 tool_calls 的工具轮与不带 tool_calls 的
   * 最终轮同构——轮次性质由 tool_calls 有无判别，不再用 msg_type 区分。
   * 中间轮仍以 react_intermediate 隐藏；final = runs.final_message_id 指向的那条。
   */
  ROUND: "round",
  /** failed/interrupted Run 的非空终态消息，既是用户可见提示也是下一轮上下文边界。 */
  RUN_TERMINAL: "run_terminal",
  /** tool_result——工具执行结果回灌(tool role)。 */
  OBSERVATION: "observation",
  /** 上下文压缩摘要(role=assistant 载体,历史按 replaces_up_to_seq 截断)。 */
  CONTEXT_COMPRESSION_SUMMARY: "context_compression_summary",
} as const;

export type MessageKind = (typeof MSG_TYPE)[keyof typeof MSG_TYPE];
