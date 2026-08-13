/**
 * Dispatcher —— 纯事件推流（B1：落库迁回 backend-ts event-persister）。
 *
 * SDK 收窄为纯计算内核后，Dispatcher 不再落库，只把内核 emit 的 KernelEvent 推进 handle.events
 * 队列，供消费端（backend-ts consumeEvents）翻译落库（KernelEventPersister）+ 推 Envelope。
 *
 * 职责只剩一件：实现 EventSink，内核 emit → push 队列。runKernel 结束/出错时 close 队列，
 * 让消费端的 for await 退出。终态收口（最终 message + run_steps + updateRunStatus）由 backend
 * 在 await handle.result 后用 persister.finalize 合一事务完成。
 *
 * 实现 EventSink：注入内核（protocol/tools/kernel 的 events 槽）。
 */
import type { EventSink, KernelEvent } from "./contracts.js";
import { AsyncQueue } from "./async-queue.js";

export class Dispatcher implements EventSink {
  readonly events = new AsyncQueue<KernelEvent>();

  constructor(private readonly onEvent?: (event: KernelEvent) => void) {}

  emit(event: KernelEvent): void {
    // Notify the host synchronously so it can reserve the event's durable
    // journal position before the kernel advances to a refresher/input.
    this.onEvent?.(event);
    this.events.push(event);
  }

  close(): void {
    this.events.close();
  }
}
