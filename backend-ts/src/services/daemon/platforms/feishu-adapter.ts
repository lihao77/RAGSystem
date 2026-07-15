import * as lark from "@larksuiteoapi/node-sdk";

import type { BotFeishuConfig } from "../../../contracts/bot.js";

export interface FeishuMessageEvent {
  message?: {
    chat_id?: string;
    chat_type?: string;
    content?: string;
    message_type?: string;
    message_id?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  };
}

export interface FeishuHandlers {
  onMessage(data: unknown): Promise<void> | void;
  onCardAction(data: FeishuCardActionEvent): Promise<unknown> | unknown;
}

export interface FeishuCardActionEvent {
  action?: {
    value?: unknown;
    tag?: string;
  };
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  open_chat_id?: string;
  open_message_id?: string;
}

export type FeishuClient = lark.Client;
export type FeishuDispatcher = lark.EventDispatcher;

export interface FeishuLongConnectionHandle {
  started: Promise<void>;
  close(): void;
}

export function createFeishuClient(connection: BotFeishuConfig): FeishuClient {
  if (!connection.app_id || !connection.app_secret) {
    throw new Error("飞书 app_id/app_secret 未配置");
  }
  return new lark.Client({
    appId: connection.app_id,
    appSecret: connection.app_secret,
  });
}

export function createDispatcher(connection: BotFeishuConfig, handlers: FeishuHandlers): FeishuDispatcher {
  return new lark.EventDispatcher({
    ...(connection.encoding_aes_key ? { encryptKey: connection.encoding_aes_key } : {}),
    ...(connection.token ? { verificationToken: connection.token } : {}),
  }).register({
    "im.message.receive_v1": handlers.onMessage,
    "card.action.trigger": handlers.onCardAction,
  });
}

export async function sendTextMessage(
  client: FeishuClient,
  receiveId: string,
  receiveIdType: "chat_id" | "open_id",
  content: string,
): Promise<unknown> {
  return client.im.message.create({
    data: {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text: content }),
    },
    params: {
      receive_id_type: receiveIdType,
    },
  });
}

export async function sendInteractiveCard(
  client: FeishuClient,
  input: { chatId: string; cardSchema: lark.InteractiveCard },
): Promise<unknown> {
  return client.im.message.create({
    data: {
      receive_id: input.chatId,
      msg_type: "interactive",
      content: JSON.stringify(input.cardSchema),
    },
    params: {
      receive_id_type: "chat_id",
    },
  });
}

export function buildApprovalCard(input: {
  approvalId: string;
  sessionId: string;
  botId: string;
  toolName: string;
  riskLevel?: string | null | undefined;
  reason?: string | null | undefined;
}): lark.InteractiveCard {
  const riskText = input.riskLevel ? `\n**风险等级：** ${input.riskLevel}` : "";
  const reasonText = input.reason ? `\n**原因：** ${input.reason}` : "";
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Agent 工具执行审批" },
    },
    elements: [
      {
        tag: "markdown",
        content: `Agent 请求执行工具 **${input.toolName}**。${riskText}${reasonText}`,
      },
      {
        tag: "action",
        layout: "bisected",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "批准" },
            value: {
              kind: "approval",
              approvalId: input.approvalId,
              sessionId: input.sessionId,
              botId: input.botId,
              decision: "approve",
            },
          },
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "拒绝" },
            value: {
              kind: "approval",
              approvalId: input.approvalId,
              sessionId: input.sessionId,
              botId: input.botId,
              decision: "deny",
            },
          },
        ],
      },
    ],
  };
}

export function buildUserInputCard(input: {
  inputId: string;
  sessionId: string;
  botId: string;
  prompt: string;
  options?: string[] | undefined;
}): lark.InteractiveCard {
  const options = input.options?.filter((option) => option.trim()).map((option) => option.trim()) ?? [];
  const elements: lark.InteractiveCardElement[] = [
    { tag: "markdown", content: input.prompt || "Agent 正在等待你的输入。" },
  ];
  if (options.length > 0) {
    elements.push({
      tag: "action",
      layout: "flow",
      actions: options.map((option) => ({
        tag: "button" as const,
        type: "default" as const,
        text: { tag: "plain_text" as const, content: option },
        value: {
          kind: "user_input",
          inputId: input.inputId,
          sessionId: input.sessionId,
          botId: input.botId,
          value: option,
        },
      })),
    });
  } else {
    elements.push({
      tag: "note",
      elements: [{ tag: "plain_text", content: "当前问题需要自由文本输入，请回到原会话中回复。" }],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Agent 等待输入" },
    },
    elements,
  };
}

export async function invokeWebhook(dispatcher: FeishuDispatcher, body: Record<string, unknown>): Promise<unknown> {
  return dispatcher.invoke(body);
}

export function startLongConnection(client: FeishuClient, dispatcher: FeishuDispatcher): FeishuLongConnectionHandle {
  const wsClient = new lark.WSClient({
    appId: client.appId,
    appSecret: client.appSecret,
  });
  return {
    started: wsClient.start({ eventDispatcher: dispatcher }),
    close: () => wsClient.close({ force: true }),
  };
}
