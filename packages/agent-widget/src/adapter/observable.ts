import type { Observable, Unsubscribe } from "@ragsystem/agent-protocol";

/**
 * agent-protocol 最小 Observable 的同步实现。
 *
 * 持有当前快照，订阅时立即回放 + 后续 set 通知所有 listener。不依赖任何响应式运行时；
 * adapter 的 status / events / executionTree / runStatus / pendingInteractions 各持有一个。
 */
export class ObservableValue<T> implements Observable<T> {
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private current: T) {}

  get(): T {
    return this.current;
  }

  set(value: T): void {
    if (Object.is(value, this.current)) {
      return;
    }
    this.current = value;
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  subscribe(listener: (value: T) => void): Unsubscribe {
    listener(this.current);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
