/**
 * session 范围记忆对账：兜底"实体已删但事件未送达"的孤儿记忆
 * （进程在删除提交与事件扇出间崩溃，或本特性上线前遗留的存量数据）。
 *
 * 只对账 session 范围：sessionId 是不可重建的 UUID，"会话不存在 ⇒ 记忆可清"
 * 恒成立。team/agent 范围不做对账——同名实体重建后清扫会误删新实体的记忆，
 * 它们只依赖事件保证。
 *
 * 运行在租户记忆 runtime 内：runtime 创建时立即对账一次，存活期间低频复查；
 * 定时器 unref，不阻止进程退出，dispose 时停止。
 */

/** 复查间隔：对账是兜底而非实时路径，小时级足够。 */
const SESSION_RECONCILE_INTERVAL_MS = 60 * 60_000;

export interface SessionMemoryReconcileDependencies {
  /** 落盘的 session scope 标识（sessionId）。 */
  listSessionScopeIds(): string[] | Promise<string[]>;
  /** 会话是否仍然存在；返回 null/undefined 视为已删除。 */
  getSession(sessionId: string): Promise<unknown> | unknown;
  /** 清理单个 session 范围记忆。 */
  purgeSession(sessionId: string): Promise<boolean> | boolean;
}

export interface SessionMemoryReconciliation {
  stop(): void;
}

export function startSessionMemoryReconciliation(
  dependencies: SessionMemoryReconcileDependencies,
): SessionMemoryReconciliation {
  let stopped = false;
  const reconcile = async (): Promise<void> => {
    const sessionIds = await dependencies.listSessionScopeIds();
    for (const sessionId of sessionIds) {
      if (stopped) return;
      const session = await dependencies.getSession(sessionId);
      if (!session) await dependencies.purgeSession(sessionId);
    }
  };
  void reconcile().catch(() => undefined);
  const timer = setInterval(() => {
    if (stopped) return;
    void reconcile().catch(() => undefined);
  }, SESSION_RECONCILE_INTERVAL_MS);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
