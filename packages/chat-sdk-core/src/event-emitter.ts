import type { Unsubscribe } from "@ragsystem/agent-protocol";

export type RagChatEventListener = (payload: unknown) => void;

export class RagChatEventEmitter {
  private readonly listeners = new Map<string, Set<RagChatEventListener>>();

  on(type: string, listener: RagChatEventListener): Unsubscribe {
    if (typeof listener !== "function") throw new TypeError("事件监听器必须是函数");
    const group = this.listeners.get(type) ?? new Set<RagChatEventListener>();
    group.add(listener);
    this.listeners.set(type, group);
    return () => this.off(type, listener);
  }

  off(type: string, listener: RagChatEventListener): void {
    const group = this.listeners.get(type);
    if (!group) return;
    group.delete(listener);
    if (group.size === 0) this.listeners.delete(type);
  }

  emit(type: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      try {
        listener(payload);
      } catch (error) {
        if (typeof globalThis.reportError === "function") globalThis.reportError(error);
        else console.error(`RagChat ${type} listener failed`, error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
