/**
 * 委托工具调用等待器（per-callId pending promise）。
 *
 * backend 转发壳 Tool.call 注册等待 → 前端 tool_result 回传 resolve / 超时 / abort reject。
 * 同一个 run 的 abortSignal 经 ToolExecContext.signal 透传到壳 call，故每个 wait 自监听 signal；
 * run 停止时 signal abort 触发所有 in-flight wait 各自 reject，无需全局 rejectAll。
 */
import { RuntimeAbortError } from "@ragsystem/agent-sdk";

export interface DelegationResolution {
  ok: boolean;
  observation?: string;
  error?: string;
  elapsedMs?: number;
}

interface PendingEntry {
  resolve: (resolution: DelegationResolution) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class DelegationPendingService {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly defaultDeadlineMs: number;

  constructor(options?: { defaultDeadlineMs?: number }) {
    this.defaultDeadlineMs = options?.defaultDeadlineMs ?? 120_000;
  }

  /** 注册等待并返回 promise；超时/abort 自动 reject，前端回传由 resolve() 唤醒。 */
  wait(callId: string, options?: { deadlineMs?: number; signal?: AbortSignal }): Promise<DelegationResolution> {
    // 同 callId 重复等待（不应发生）：先拒绝旧的，避免悬挂。
    const existing = this.pending.get(callId);
    if (existing) {
      this.cleanup(callId);
      existing.reject(new Error("工具委托等待被新请求覆盖"));
    }
    return new Promise<DelegationResolution>((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject };
      const deadline = options?.deadlineMs ?? this.defaultDeadlineMs;
      if (Number.isFinite(deadline) && deadline > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.get(callId) === entry) {
            this.cleanup(callId);
            reject(new Error(`工具委托执行超时(${deadline}ms)`));
          }
        }, deadline);
      }
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) {
          this.cleanup(callId);
          reject(new RuntimeAbortError("工具委托执行已取消"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            if (this.pending.get(callId) === entry) {
              this.cleanup(callId);
              reject(new RuntimeAbortError("工具委托执行已取消"));
            }
          },
          { once: true },
        );
      }
      this.pending.set(callId, entry);
    });
  }

  /** 前端 tool_result 回传 → resolve 对应 wait；返回是否命中 pending。 */
  resolve(callId: string, resolution: DelegationResolution): boolean {
    const entry = this.pending.get(callId);
    if (!entry) {
      return false;
    }
    this.cleanup(callId);
    entry.resolve(resolution);
    return true;
  }

  private cleanup(callId: string): void {
    const entry = this.pending.get(callId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.pending.delete(callId);
  }
}
