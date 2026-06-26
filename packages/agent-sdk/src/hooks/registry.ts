/**
 * HookRegistry 默认实现。
 *
 * 存储：Map<event, Set<handler>>。Set 保证同一 handler 不会重复注册；反注册直接 delete。
 * emit：顺序 await 所有 handler，**聚合输出**——
 *   - decision：deny > ask > allow（任一 deny 即 deny；否则 ask 压过 allow；决策与 reason 取自同一 handler）
 *   - 注入字段（modifiedInput / modifiedResult / additionalContext）：末个非 undefined 生效
 *   - metadata：多 handler 浅合并（后者覆盖前者）
 *   - 单个 handler 异常 catch 不阻断其余；异常记进 metadata.hook_errors 供观测
 */
import { EMPTY_HOOK_OUTPUT, type BaseHookOutput, type HookDecision, type HookEvent, type HookHandler, type HookInputMap, type HookOutputMap, type HookRegistry } from "./types.js";

/** 聚合用的全字段并集（所有事件输出类型的超集；非该事件的字段保持 absent）。 */
interface AggregatedOutput extends BaseHookOutput {
  decision?: HookDecision;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  modifiedResult?: unknown;
  additionalContext?: string;
}

const DECISION_RANK: Record<HookDecision, number> = { allow: 1, ask: 2, deny: 3 };

export function createHookRegistry(): HookRegistry {
  const handlers = new Map<HookEvent, Set<HookHandler<HookEvent>>>();

  return {
    on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as unknown as HookHandler<HookEvent>);
      return () => {
        const current = handlers.get(event);
        if (!current) {
          return;
        }
        current.delete(handler as unknown as HookHandler<HookEvent>);
        if (current.size === 0) {
          handlers.delete(event);
        }
      };
    },

    async emit<E extends HookEvent>(event: E, input: HookInputMap[E]): Promise<HookOutputMap[E]> {
      const set = handlers.get(event);
      if (!set || set.size === 0) {
        return EMPTY_HOOK_OUTPUT as HookOutputMap[E];
      }
      const aggregated: AggregatedOutput = {};
      let hasMetadata = false;
      let metadata: Record<string, unknown> | undefined;
      let hookErrors: Array<{ event: HookEvent; message: string }> | undefined;

      for (const handler of set) {
        try {
          const output = await handler(input as HookInputMap[HookEvent]);
          if (!output) {
            continue;
          }
          // metadata 浅合并
          if (output.metadata && Object.keys(output.metadata).length > 0) {
            hasMetadata = true;
            metadata = { ...(metadata ?? {}), ...output.metadata };
          }
          // decision：deny>ask>allow，取最高优先级（及其 reason）
          const candidate = output as Partial<AggregatedOutput>;
          if (candidate.decision && DECISION_RANK[candidate.decision] > DECISION_RANK[aggregated.decision ?? "allow"]) {
            aggregated.decision = candidate.decision;
            if (candidate.reason !== undefined) {
              aggregated.reason = candidate.reason;
            } else if (aggregated.reason !== undefined) {
              delete aggregated.reason;
            }
          }
          // 注入字段：末个非 undefined 生效
          if (candidate.modifiedInput !== undefined) {
            aggregated.modifiedInput = candidate.modifiedInput;
          }
          if (candidate.modifiedResult !== undefined) {
            aggregated.modifiedResult = candidate.modifiedResult;
          }
          if (candidate.additionalContext !== undefined) {
            aggregated.additionalContext = candidate.additionalContext;
          }
        } catch (error) {
          if (!hookErrors) {
            hookErrors = [];
          }
          hookErrors.push({ event, message: error instanceof Error ? error.message : String(error) });
        }
      }

      if (hasMetadata && metadata) {
        aggregated.metadata = metadata;
      }
      if (hookErrors) {
        aggregated.metadata = { ...(aggregated.metadata ?? {}), hook_errors: hookErrors };
      }

      const hasAny =
        aggregated.decision !== undefined ||
        aggregated.modifiedInput !== undefined ||
        aggregated.modifiedResult !== undefined ||
        aggregated.additionalContext !== undefined ||
        aggregated.metadata !== undefined;
      return (hasAny ? aggregated : EMPTY_HOOK_OUTPUT) as HookOutputMap[E];
    },
  };
}
