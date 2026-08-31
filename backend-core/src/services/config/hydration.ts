/**
 * 数据水合/迁移链内核：按序执行幂等步骤，返回实际生效的步骤记录。
 *
 * 设计约定（详见 backend-core/MIGRATIONS.md）：
 * - 步骤必须幂等：对已是当前形态的数据原样通过（返回 false），任何历史版本的数据
 *   都能沿链收敛——跳版升级、备份恢复、手工编辑后的半迁移状态同样安全。
 * - 步骤分两类：可退役的「迁移步骤」（针对特定历史形状，登记进 MIGRATIONS.md，
 *   保留到宣布最低支持版本为止）与永久的「形态归一层」（同时服务新建/更新路径，
 *   永不退役）。内核不区分两者，语义由各存储的步骤清单与文档声明。
 * - 应用记录（stamp）只描述"该步骤本次实际改动了数据"，仅由持久层随数据回写
 *   落盘；它用于排查审计，不参与"要不要执行"的决策——执行永远由形状驱动。
 * - 异常语义与现状一致：传播并导致加载失败，但包装上 step id 便于定位。
 */

/** 单个水合/迁移步骤。run 返回是否有改动；必须幂等。 */
export interface HydrationStep<T> {
  /** 稳定 id，必须登记进 backend-core/MIGRATIONS.md（有清单自证测试）。 */
  id: string;
  /** 针对的历史形状与引入背景，供 MIGRATIONS.md 与排查使用。 */
  note: string;
  run(target: T): boolean;
}

/** 步骤实际改动了数据的应用记录（审计用；含时间）。 */
export interface AppliedHydrationStep {
  id: string;
  applied_at: string;
}

/** 按声明顺序执行全部步骤（无条件，无短路），返回实际生效的步骤。 */
export function runHydrationChain<T>(
  steps: readonly HydrationStep<T>[],
  target: T,
): AppliedHydrationStep[] {
  const applied: AppliedHydrationStep[] = [];
  for (const step of steps) {
    let changed: boolean;
    try {
      changed = step.run(target);
    } catch (error) {
      throw new Error(
        `hydration step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (changed) {
      applied.push({ id: step.id, applied_at: new Date().toISOString() });
    }
  }
  return applied;
}
