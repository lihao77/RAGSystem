import type { AguiInterrupt } from "./agui-events.js";

/** 网关侧 interrupt 段记录：把 AG-UI interrupt（外部 run 边界）与内部 run/调用关联。 */
export type InterruptKind = "delegate" | "approval" | "user_input";

export interface InterruptRecord {
  threadId: string;
  /** AG-UI interrupt.id（网关生成），client resume 数组用它引用。 */
  aguiInterruptId: string;
  /** 内部关联键：delegate=delegation callId，interaction=approvalId/inputId。 */
  callId: string;
  kind: InterruptKind;
  /** 本次 interrupt 所属的内部 run（resume 段继续订阅它）。 */
  internalRunId: string;
  toolCallId?: string;
  toolName?: string;
  /** 完整 AG-UI interrupt 定义（含 reason/responseSchema，便于诊断与后续回放）。 */
  interrupt: AguiInterrupt;
}

/**
 * interrupt run 折叠状态机（进程内单例）。
 *
 * 内部一个连续 run 在 AG-UI 外部可能折叠成多段 run：遇 delegate_call / interaction(required)
 * 时网关发 RUN_FINISHED{interrupt} 结束当前 SSE 流，内部 run 继续阻塞；client resume 时按
 * aguiInterruptId 取回记录，调内部 resolve/respond 唤醒同一 internalRunId 继续。
 *
 * 仅存进程内：AG-UI interrupt 本身有 resume 契约约束（同 thread 必须 cover 所有 open interrupt），
 * 进程重启后 in-flight interrupt 视为失效（内部 pending 也有超时/abort 兜底）。
 */
export class InterruptMachine {
  private readonly records = new Map<string, InterruptRecord>();

  record(entry: InterruptRecord): void {
    this.records.set(entry.aguiInterruptId, entry);
  }

  /** resume 时取回并删除；未命中返回 null（已过期/被取消/不归属本实例）。 */
  take(aguiInterruptId: string): InterruptRecord | null {
    const entry = this.records.get(aguiInterruptId);
    if (!entry) {
      return null;
    }
    this.records.delete(aguiInterruptId);
    return entry;
  }

  peek(aguiInterruptId: string): InterruptRecord | null {
    return this.records.get(aguiInterruptId) ?? null;
  }
}
