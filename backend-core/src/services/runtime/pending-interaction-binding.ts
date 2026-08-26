import type { PendingInteractionNotice, PendingInteractionPort } from "../../contracts/runtime/pending-interactions.js";

export interface PendingInteractionBinding {
  /** 稳定引用：装配期即可交给插件 runtime factory，bind 后透传到真实协调器。 */
  readonly port: PendingInteractionPort;
  /** 容器构造完交互协调器后回填真实实现。 */
  bind(target: PendingInteractionPort): void;
}

/**
 * 两套部署装配都是先调 plugins.createRuntime 再 createCoreRuntimeContainer（协调器在后
 * 者内部构造），port 因此以延迟绑定方式暴露：装配层先把稳定引用传入 runtime context，
 * 容器建好协调器后 bind。bind 前调用属于装配期误用（人工交互只应发生在工具执行期），
 * 直接抛错尽早暴露。
 *
 * 例外是 onInteractionRequired（观察型订阅）：通知类插件（如桌宠）在 runtime factory
 * 里就要订阅，而那时协调器尚未构造——先登记到本地集合，bind 时统一转挂到真实协调器。
 */
export function createPendingInteractionBinding(): PendingInteractionBinding {
  let target: PendingInteractionPort | null = null;
  const earlyNoticeHandlers = new Set<(notice: PendingInteractionNotice) => void>();
  const requireTarget = (): PendingInteractionPort => {
    if (!target) {
      throw new Error("pendingInteractions used before the runtime container bound it");
    }
    return target;
  };
  return {
    port: {
      onRootFinalized(...args: Parameters<PendingInteractionPort["onRootFinalized"]>) {
        return requireTarget().onRootFinalized(...args);
      },
      waitForUserInput(input) {
        return requireTarget().waitForUserInput(input);
      },
      waitForApproval(input) {
        return requireTarget().waitForApproval(input);
      },
      cancelSession(...args: Parameters<PendingInteractionPort["cancelSession"]>) {
        return requireTarget().cancelSession(...args);
      },
      onInteractionRequired(handler) {
        if (target) return target.onInteractionRequired(handler);
        earlyNoticeHandlers.add(handler);
        return () => { earlyNoticeHandlers.delete(handler); };
      },
    },
    bind(next) {
      target = next;
      for (const handler of earlyNoticeHandlers) next.onInteractionRequired(handler);
      earlyNoticeHandlers.clear();
    },
  };
}
