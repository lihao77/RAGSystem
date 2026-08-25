import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";

/** 单次投递的内容：运行结果或挂起交互（由通道决定呈现形式，如文本/卡片）。 */
export interface SchedulerDeliveryInput {
  tenantId: TenantId;
  taskId: string;
  sessionId: string;
  channel: string;
  target: string | null;
  botId: string | null;
  suspended: boolean;
  content: string;
}

export interface SchedulerDeliveryChannel {
  /** 通道 id（与任务 delivery.channel 匹配），如 "feishu"。 */
  readonly id: string;
  deliver(input: SchedulerDeliveryInput): Promise<void>;
}

/**
 * 按通道名派生 capability token（registry 按 token.id 字符串键控，动态构造可命中）。
 * 通道插件在自己的 runtimes.register 贡献 provide(schedulerDeliveryChannelToken("feishu"), channel)。
 */
export function schedulerDeliveryChannelToken(channel: string) {
  return createCapability<SchedulerDeliveryChannel>(`scheduler.delivery-channel:${channel.trim()}`);
}

export type { TenantId, UserId };
