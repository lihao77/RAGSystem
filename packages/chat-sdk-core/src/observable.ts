import type { Envelope, Observable, Unsubscribe } from "@ragsystem/agent-protocol";

/**
 * agent-protocol 最小 Observable 的同步实现。
 *
 * 持有当前快照，订阅时立即回放 + 后续 set 通知所有 listener。不依赖任何响应式运行时；
 * adapter 的 status / executionTree / runStatus / pendingInteractions 各持有一个。
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

/** 无事件哨兵：EventStream 在尚未收到任何 Envelope 时 get() 返回此值（合法 ack 帧结构，session_id 空）。 */
export const NO_EVENT: Envelope = { type: "ack", session_id: "" };

/**
 * 事件流 Observable：用于 events。
 *
 * 与 ObservableValue 的区别——subscribe **不立即回放**（事件流无"当前快照"语义，
 * 避免订阅者先收到一个 null/哨兵）；get() 返回最近一条 Envelope，无事件时为 NO_EVENT 哨兵。
 * 消费者应优先用 subscribe 消费流；get() 仅在确需最近事件时用，并知晓初始可能为哨兵。
 */
export class EventStream implements Observable<Envelope> {
  private last: Envelope = NO_EVENT;
  private readonly listeners = new Set<(env: Envelope) => void>();

  emit(env: Envelope): void {
    this.last = env;
    for (const listener of this.listeners) {
      listener(env);
    }
  }

  get(): Envelope {
    return this.last;
  }

  subscribe(listener: (env: Envelope) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
