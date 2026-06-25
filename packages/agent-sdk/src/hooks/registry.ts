/**
 * HookRegistry 默认实现。
 *
 * 存储：Map<event, Set<handler>>。Set 保证同一 handler 不会重复注册；反注册直接 delete。
 * emit：顺序 await 所有 handler，合并 metadata（后者覆盖前者），单个 handler 异常 catch 不阻断其余。
 * 返回值约定：handler 返回 void/undefined 视为无产出（不贡献 metadata）。
 */
import { EMPTY_HOOK_OUTPUT, type HookEvent, type HookHandler, type HookInputMap, type HookOutput, type HookRegistry } from "./types.js";

export function createHookRegistry(): HookRegistry {
  const handlers = new Map<HookEvent, Set<HookHandler<HookEvent>>>();

  return {
    on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as HookHandler<HookEvent>);
      return () => {
        const current = handlers.get(event);
        if (!current) {
          return;
        }
        current.delete(handler as HookHandler<HookEvent>);
        if (current.size === 0) {
          handlers.delete(event);
        }
      };
    },

    async emit<E extends HookEvent>(event: E, input: HookInputMap[E]): Promise<HookOutput> {
      const set = handlers.get(event);
      if (!set || set.size === 0) {
        return EMPTY_HOOK_OUTPUT;
      }
      let metadata: Record<string, unknown> | undefined;
      for (const handler of set) {
        try {
          const output = await handler(input as HookInputMap[HookEvent]);
          if (output?.metadata && Object.keys(output.metadata).length > 0) {
            metadata = { ...(metadata ?? {}), ...output.metadata };
          }
        } catch (error) {
          // 单个 handler 异常不阻断其余 handler；记录到 metadata.hook_errors 供观测。
          const message = error instanceof Error ? error.message : String(error);
          metadata = { ...(metadata ?? {}) };
          const errors = Array.isArray(metadata.hook_errors) ? metadata.hook_errors : [];
          errors.push({ event, message });
          metadata.hook_errors = errors;
        }
      }
      return metadata ? { metadata } : EMPTY_HOOK_OUTPUT;
    },
  };
}
