import type { PluginHookRegistrar } from "@ragsystem/backend-core/plugins/backend-plugin.js";

export interface PetActivitySnapshot {
  /** 进行中的 run 数量（跨会话/租户，插件级计数）。 */
  readonly activeRuns: number;
  /** 最近一次 run 失败（或工具异常）的时间戳（ms）；null = 尚未发生。 */
  readonly lastErrorAt: number | null;
  /** 最近一次 run 完成的时间戳（ms）；null = 尚未发生。 */
  readonly lastCompletedAt: number | null;
  /** 最近一次 run 终态摘要（completed=最终回复截断 / failed=错误信息截断）；null = 无。 */
  readonly lastSummary: string | null;
  /** busy 期间的工具映射提示 { anim, at }：前端据此切换"正在做什么"的动画；null = 无。 */
  readonly busyHint: { readonly anim: string; readonly at: number } | null;
  /** 最近一次等待用户的交互（审批/用户输入），系统通知事件源；null = 无。 */
  readonly lastInteraction: PetInteractionNotice | null;
}

/** 等待用户的交互通知（来自 pendingInteractions.onInteractionRequired）。 */
export interface PetInteractionNotice {
  readonly id: string;
  readonly kind: "approval" | "user_input";
  /** approval：工具名；user_input："request_user_input"。 */
  readonly tool: string;
  readonly prompt: string | null;
  readonly reason: string | null;
  /** 时间戳（ms）。 */
  readonly at: number;
}

/** 摘要截断长度（前端气泡展示用）。 */
const SUMMARY_LIMIT = 80;
/** 同一工具提示的最小间隔（ms）：防止连续工具调用把动画切得支离破碎。 */
const HINT_THROTTLE_MS = 8_000;

/** 工具名 → 桌宠动画映射（子串匹配，按序取首个命中）。 */
const TOOL_ANIM_RULES: readonly (readonly [pattern: string, anim: string])[] = [
  ["bash", "原地敲击桌面互动"],
  ["exec", "原地敲击桌面互动"],
  ["terminal", "原地敲击桌面互动"],
  ["code", "写代码"],
  ["edit", "写代码"],
  ["write", "轻快记录"],
  ["file", "轻快记录"],
  ["read", "轻快记录"],
  ["search", "深度思考碎碎念"],
  ["browse", "深度思考碎碎念"],
  ["web", "深度思考碎碎念"],
  ["knowledge", "照镜子"],
  ["image", "照镜子"],
  ["mcp", "轻快记录"],
];

export function mapToolToAnimation(toolName: string): string | null {
  const name = toolName.toLowerCase();
  for (const [pattern, anim] of TOOL_ANIM_RULES) {
    if (name.includes(pattern)) return anim;
  }
  return null;
}

function truncateSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > SUMMARY_LIMIT ? `${normalized.slice(0, SUMMARY_LIMIT)}…` : normalized;
}

/**
 * agent 运行活跃度跟踪：经 run/tool 级钩子维护计数、终态摘要与工具映射提示，
 * 供 GET /api/pet/state 与 /api/pet/events SSE 输出，驱动桌宠状态联动。
 * 观察型 handler（返回 void），不参与 deny/注入语义。
 */
export class PetActivityTracker {
  private activeRuns = 0;
  private lastErrorAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private lastSummary: string | null = null;
  private busyHint: { anim: string; at: number } | null = null;
  private lastInteraction: PetInteractionNotice | null = null;
  private lastHintAt = 0;
  private readonly listeners = new Set<(snapshot: PetActivitySnapshot) => void>();

  /** 订阅状态变化（SSE 推送用），返回退订函数。 */
  onChange(listener: (snapshot: PetActivitySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  install(hooks: PluginHookRegistrar): void {
    hooks.on("run.before", () => {
      this.activeRuns += 1;
      this.busyHint = null;
      this.notify();
    });
    hooks.on("run.finally", (input) => {
      this.activeRuns = Math.max(0, this.activeRuns - 1);
      if (input.status === "completed") {
        this.lastCompletedAt = Date.now();
        this.lastSummary = truncateSummary(extractResultText(input.result));
      }
      if (input.status === "failed") {
        this.lastErrorAt = Date.now();
        this.lastSummary = truncateSummary(input.error instanceof Error ? input.error.message : String(input.error ?? "运行失败"));
      }
      // aborted / suspended 不计入错误，也不算完成（挂起等用户输入时宠物按 busy 消退自然回 idle）
      this.notify();
    });
    hooks.on("tool.error", () => {
      this.lastErrorAt = Date.now();
      this.notify();
    });
    hooks.on("tool.before", (input) => {
      const anim = mapToolToAnimation(input.toolName);
      if (!anim || this.activeRuns <= 0) return;
      const now = Date.now();
      if (now - this.lastHintAt < HINT_THROTTLE_MS) return;
      this.lastHintAt = now;
      this.busyHint = { anim, at: now };
      this.notify();
    });
  }

  snapshot(): PetActivitySnapshot {
    return {
      activeRuns: this.activeRuns,
      lastErrorAt: this.lastErrorAt,
      lastCompletedAt: this.lastCompletedAt,
      lastSummary: this.lastSummary,
      busyHint: this.busyHint,
      lastInteraction: this.lastInteraction,
    };
  }

  /** 审批/用户输入进入 pending（run 挂起等用户）——前端据此弹系统通知。 */
  noteInteractionRequired(notice: Omit<PetInteractionNotice, "at">): void {
    this.lastInteraction = { ...notice, at: Date.now() };
    this.notify();
  }
}

/** 从 KernelResult 提取最终回复文本（各 contentParts 兜底取纯文本 part）。 */
function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const record = result as { content?: unknown; contentParts?: unknown };
  if (typeof record.content === "string" && record.content.trim()) return record.content;
  if (Array.isArray(record.contentParts)) {
    return record.contentParts
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join(" ")
      .trim();
  }
  return "";
}
