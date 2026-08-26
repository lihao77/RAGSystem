/**
 * 实体生命周期事件契约。
 *
 * 领域服务（AgentSessionApplication / AgentConfigService）在实体删除或重命名
 * 成功提交后，通过注入的发布端口把事实广播到插件应用事件总线；插件用
 * context.events.on 订阅（消费模式见 backend-plugin-agent-builder）。事件在
 * 服务层发布而非路由层，保证任何调用路径（HTTP、程序化、未来的租户销毁）
 * 都不漏发。
 *
 * 语义约定：
 * - 事实通知，尽力送达：进程内同步扇出、不落 outbox；单个订阅 handler 抛错
 *   只记日志，不影响发布方已成功的变更（BackendApplicationEventRegistry 隔离）。
 * - payload 一律携带 tenantId；订阅方按 tenantId 定位租户运行时后再清理。
 * - 与 agent.config.changed 的分工：后者是"草稿同步触发器"（路由层、含任意
 *   配置写操作），本契约是"实体生命周期事实"，两者并存不互相替代。
 *
 * 已知限制：
 * - resetDefaultTeam 重写 default team 配置时不逐 agent 发布 agent.deleted；
 * - 绕过领域服务直接改存储的删除不产生事件；
 * - 进程在变更提交与扇出之间崩溃会漏发，session 范围由记忆插件的对账清扫
 *   兜底（team/agent 不清扫，防同名重建误删）。
 */
export const SESSION_DELETED_EVENT = "session.deleted";

export interface SessionDeletedEvent {
  tenantId: string;
  sessionId: string;
}

export const AGENT_DELETED_EVENT = "agent.deleted";

export interface AgentDeletedEvent {
  tenantId: string;
  teamName: string;
  agentName: string;
}

export const TEAM_DELETED_EVENT = "team.deleted";

export interface TeamDeletedEvent {
  tenantId: string;
  teamName: string;
}

export const TEAM_RENAMED_EVENT = "team.renamed";

export interface TeamRenamedEvent {
  tenantId: string;
  previousTeamName: string;
  teamName: string;
}

export type EntityLifecycleEventName =
  | typeof SESSION_DELETED_EVENT
  | typeof AGENT_DELETED_EVENT
  | typeof TEAM_DELETED_EVENT
  | typeof TEAM_RENAMED_EVENT;

export type EntityLifecycleEvent =
  | SessionDeletedEvent
  | AgentDeletedEvent
  | TeamDeletedEvent
  | TeamRenamedEvent;

/**
 * 宿主注入领域服务的发布端口。实现方负责隔离订阅 handler 的错误；
 * 服务在变更成功后调用，发布失败不应使变更回滚或向调用方报错。
 */
export type EntityLifecyclePublisher = (
  event: EntityLifecycleEventName,
  payload: EntityLifecycleEvent,
) => Promise<void>;

/** 组合根构造的注入形态：发布端口与租户绑定，服务不再自行推导 tenantId。 */
export interface EntityLifecycleBinding {
  tenantId: string;
  publish: EntityLifecyclePublisher;
}

export function isSessionDeletedEvent(value: unknown): value is SessionDeletedEvent {
  return isLifecycleRecord(value)
    && typeof value.sessionId === "string"
    && Boolean(value.sessionId.trim());
}

export function isAgentDeletedEvent(value: unknown): value is AgentDeletedEvent {
  return isLifecycleRecord(value)
    && typeof value.teamName === "string"
    && Boolean(value.teamName.trim())
    && typeof value.agentName === "string"
    && Boolean(value.agentName.trim());
}

export function isTeamDeletedEvent(value: unknown): value is TeamDeletedEvent {
  return isLifecycleRecord(value)
    && typeof value.teamName === "string"
    && Boolean(value.teamName.trim());
}

export function isTeamRenamedEvent(value: unknown): value is TeamRenamedEvent {
  return isLifecycleRecord(value)
    && typeof value.previousTeamName === "string"
    && Boolean(value.previousTeamName.trim())
    && typeof value.teamName === "string"
    && Boolean(value.teamName.trim());
}

function isLifecycleRecord(value: unknown): value is Record<string, unknown> & { tenantId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const tenantId = (value as Record<string, unknown>).tenantId;
  return typeof tenantId === "string" && Boolean(tenantId.trim());
}
