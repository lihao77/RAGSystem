/**
 * Agent 微内核 — HookRegistry 默认实现。
 *
 * 内部按 HookPoint 维护 fn 数组；invoke 顺序 await 执行该 point 下所有 fn。
 * 阶段一仅 afterModel 钩子承载 stable-prefix 刷新（取代 onModelRequestSuccess），
 * beforeModel 暂空，签名预留。
 */

import type { HookPoint, HookRegistry, KernelContext } from "./contracts.js";

type HookFn = (ctx: KernelContext, round?: number) => void | Promise<void>;

export class DefaultHookRegistry implements HookRegistry {
  private readonly hooks = new Map<HookPoint, HookFn[]>();

  register(point: HookPoint, fn: HookFn): void {
    const list = this.hooks.get(point);
    if (list) {
      list.push(fn);
    } else {
      this.hooks.set(point, [fn]);
    }
  }

  async invoke(point: HookPoint, ctx: KernelContext, round?: number): Promise<void> {
    const list = this.hooks.get(point);
    if (!list) {
      return;
    }
    for (const fn of list) {
      await fn(ctx, round);
    }
  }
}
