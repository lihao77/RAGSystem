/**
 * EventSink 默认实现（kernel-plugins/events）。
 *
 * 设计（铁律：行为零变化）：
 * - RuntimeEventSink 是零翻译透传层：emit 直接把事件交给构造期注入的 publish 回调。
 *   publish 的真实实例 = publishRuntimeEvent（event-publisher.ts），下游分流（写消息表 /
 *   写 run_step / 进 outbox 投递）全部由它决定，与本类无关。本类只是把
 *   现状 `input.onEvent?.(event)` 这一调用点搬进内核扩展点。
 * - NullEventSink：emit 空操作，专供 child run（agent-delegation.executeChildRun）。
 *   现状 child run 不发任何 runtime 事件，注入本类即可维持静默，不得改为发事件。
 *
 * 事件发射点：Protocol / ToolProvider / 内核分别经 EventSink 发射
 * （runtime 流式 delta、tool_call/tool_result、done/error 等）——它们拿到的就是这个实例。
 */

import type { AgentRuntimeEvent, EventSink } from "../../kernel/contracts.js";

/**
 * 透传型 EventSink：emit 直接调用 publish，零翻译、零缓存、零异步缓冲。
 *
 * 注意：emit 返回 void（非 Promise）。现状 onEvent 虽被 `await` 调用，
 * 但 publishRuntimeEvent 自身是同步的（写库走 Transactional Outbox，不在此处 await 落库结果），
 * 因此维持同步 emit 与现状等价。若 publish 返回 Promise，其 rejection 会冒泡给调用方，
 * 行为与现状 `await input.onEvent?.(event)` 一致。
 */
export class RuntimeEventSink implements EventSink {
  constructor(
    private readonly publish: (event: AgentRuntimeEvent) => void | Promise<void>,
  ) {}

  emit(event: AgentRuntimeEvent): void {
    this.publish(event);
  }
}

/**
 * 静默型 EventSink：child run 用。emit 丢弃一切事件，不发 runtime 事件、不落库、不投递。
 * 不得改为发事件——会破坏 child 静默现状（见 docs/kernel-refactor-phase1.md 七节、十一节）。
 */
export class NullEventSink implements EventSink {
  emit(_event: AgentRuntimeEvent): void {
    // 故意空操作。
  }
}
