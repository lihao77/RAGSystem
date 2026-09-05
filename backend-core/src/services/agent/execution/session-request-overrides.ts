import { ALL_THINKING_LEVELS, type ThinkingLevel } from "@ragsystem/agent-llm";

/**
 * 会话级请求覆盖（selected_llm / thinking_level）：主智能体 default 档的"当前设定"。
 *
 * 语义：选择即设定（前端选择器变化即时 PATCH 会话 metadata，发送路径后端补写同键），
 * 会话内一切主智能体 root run 的拉起渠道都读它——用户交互通道随请求显式携带并刷新，
 * 系统渠道（mailbox 续跑 / session_followup / goal 续跑 / bg notification / 挂起恢复 /
 * collaborate）经 readSessionRequestOverrides 读回。字段 null = 当前未设定（回落
 * agent tier 默认）。
 */
export const SESSION_REQUEST_OVERRIDES_METADATA_KEY = "_request_overrides";

export interface SessionRequestOverrides {
  selectedLlm: string | null;
  thinkingLevel: ThinkingLevel | null;
}

export const EMPTY_SESSION_REQUEST_OVERRIDES: SessionRequestOverrides = {
  selectedLlm: null,
  thinkingLevel: null,
};

/**
 * 解析会话 metadata 中的请求覆盖设定。纯函数、形状驱动：键缺失/类型不符/枚举外值
 * 一律按未设定收敛（会话 metadata 同时接受前端 PATCH 与后端发送补写，两端的半迁移
 * 或手工编辑状态都不能让执行路径爆掉）。
 */
export function readSessionRequestOverrides(
  metadata: Record<string, unknown> | null | undefined,
): SessionRequestOverrides {
  const raw = metadata?.[SESSION_REQUEST_OVERRIDES_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return EMPTY_SESSION_REQUEST_OVERRIDES;
  }
  const record = raw as Record<string, unknown>;
  const selectedLlmRaw = record.selected_llm;
  const thinkingRaw = record.thinking_level;
  return {
    selectedLlm: typeof selectedLlmRaw === "string" && selectedLlmRaw.trim() ? selectedLlmRaw.trim() : null,
    thinkingLevel: typeof thinkingRaw === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(thinkingRaw)
      ? (thinkingRaw as ThinkingLevel)
      : null,
  };
}

/**
 * 请求级覆盖与继承合并：请求未携带（undefined）→ 继承会话设定；显式 null/空串 →
 * 清除（回落 agent tier 默认）；有值 → 生效。返回值即本次执行的实际口径，也是
 * metadata 回写应落的值（写回继承值保持设定不变，写回 null 即清除）。
 */
export function mergeRequestOverrides(
  request: { selectedLlm?: string | null | undefined; thinkingLevel?: ThinkingLevel | null | undefined },
  session: SessionRequestOverrides,
): SessionRequestOverrides {
  return {
    selectedLlm: request.selectedLlm !== undefined ? (request.selectedLlm?.trim() || null) : session.selectedLlm,
    thinkingLevel: request.thinkingLevel !== undefined ? (request.thinkingLevel ?? null) : session.thinkingLevel,
  };
}
