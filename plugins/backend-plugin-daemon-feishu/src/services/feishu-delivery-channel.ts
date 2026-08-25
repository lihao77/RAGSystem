import type { DaemonBotRepository } from "../contracts/bot-repository.js";
import type { DaemonService } from "./daemon-service.js";
import type { SchedulerDeliveryChannel, SchedulerDeliveryInput } from "@ragsystem/backend-plugin-scheduler/contracts/delivery.js";
import { createUserId, type UserId } from "@ragsystem/backend-core/identity/types.js";

export interface FeishuDeliveryChannelDependencies {
  /** 应用运行时就绪后可取到 DaemonService；投递发生在运行期，延迟解析即可。 */
  readonly service: () => DaemonService;
  readonly botRepository: () => DaemonBotRepository;
}

/**
 * scheduler 插件的 "feishu" 投递通道：把定时任务的运行结果/挂起通知发到飞书会话。
 * bot 选择：任务声明的 delivery.bot_id 优先，否则回退到第一个启用的飞书机器人；
 * 目标 chat_id：任务声明的 delivery.target 优先，否则回退 bot 的 feishu.default_chat_id。
 */
export function createFeishuDeliveryChannel(dependencies: FeishuDeliveryChannelDependencies): SchedulerDeliveryChannel {
  return {
    id: "feishu",
    async deliver(message: SchedulerDeliveryInput): Promise<void> {
      const repository = dependencies.botRepository();
      const chatId = message.target?.trim() || null;
      let botId: UserId | null = message.botId?.trim() ? createUserId(message.botId!.trim()) : null;
      if (!botId) {
        const fallback = (await repository.listAllEnabledFeishu())
          .find((config) => (chatId ? true : config.feishu.default_chat_id));
        if (!fallback) throw new Error("feishu 投递失败: 没有可用的飞书机器人");
        botId = fallback.bot_id;
      }
      const target = chatId ?? await resolveDefaultChatId(repository, botId);
      if (!target) throw new Error(`feishu 投递失败: bot ${botId} 未配置 default_chat_id`);
      const sent = await dependencies.service().sendMessage(botId, {
        platform: "feishu",
        chat_id: target,
        content: buildDeliveryText(message),
        message_type: "text",
      });
      if (sent.status === "failed") throw new Error(`feishu 消息发送失败: ${sent.error ?? "未知错误"}`);
    },
  };
}

async function resolveDefaultChatId(repository: DaemonBotRepository, botId: UserId): Promise<string | null> {
  const config = await repository.getConfig(botId);
  return config?.feishu.default_chat_id?.trim() || null;
}

function buildDeliveryText(message: SchedulerDeliveryInput): string {
  const prefix = `[定时任务 ${message.taskId}]`;
  if (message.suspended) {
    return `${prefix} 执行已挂起，等待人工交互处理（会话 ${message.sessionId}）。`;
  }
  const body = message.content.trim();
  return body ? `${prefix}\n${body}` : `${prefix} 执行完成。`;
}
