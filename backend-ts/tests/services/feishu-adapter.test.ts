import { describe, expect, it, vi } from "vitest";

import type { BotFeishuConfig } from "../../src/contracts/bot.js";
import {
  buildApprovalCard,
  buildUserInputCard,
  createDispatcher,
  invokeWebhook,
  sendInteractiveCard,
  type FeishuClient,
} from "../../src/services/daemon/platforms/feishu-adapter.js";

describe("飞书交互卡片适配器", () => {
  it("发送 interactive 消息到 chat_id", async () => {
    const create = vi.fn(async () => ({ data: { message_id: "om_card" } }));
    const client = { im: { message: { create } } } as unknown as FeishuClient;
    const cardSchema = buildApprovalCard({
      approvalId: "approval-1",
      sessionId: "session-1",
      botId: "bot-1",
      toolName: "execute_bash",
      riskLevel: "high",
      reason: "高风险命令",
    });

    await sendInteractiveCard(client, { chatId: "oc_chat", cardSchema });

    expect(create).toHaveBeenCalledWith({
      data: {
        receive_id: "oc_chat",
        msg_type: "interactive",
        content: JSON.stringify(cardSchema),
      },
      params: { receive_id_type: "chat_id" },
    });
  });

  it("审批卡片按钮携带恢复入口所需 value", () => {
    const card = buildApprovalCard({
      approvalId: "approval-1",
      sessionId: "session-1",
      botId: "bot-1",
      toolName: "execute_bash",
      riskLevel: "high",
      reason: "需要审批",
    });
    expect(card).toMatchObject({
      header: { template: "orange" },
      elements: [
        { tag: "markdown", content: expect.stringContaining("execute_bash") },
        {
          tag: "action",
          actions: [
            { tag: "button", type: "primary", value: { kind: "approval", approvalId: "approval-1", sessionId: "session-1", botId: "bot-1", decision: "approve" } },
            { tag: "button", type: "danger", value: { kind: "approval", approvalId: "approval-1", sessionId: "session-1", botId: "bot-1", decision: "deny" } },
          ],
        },
      ],
    });
  });

  it("用户输入卡片生成选项按钮，无选项时退化为文本提示", () => {
    const card = buildUserInputCard({
      inputId: "input-1",
      sessionId: "session-1",
      botId: "bot-1",
      prompt: "请选择环境",
      options: ["测试", "生产"],
    });
    expect(card.elements?.[1]).toMatchObject({
      tag: "action",
      actions: [
        { tag: "button", value: { kind: "user_input", inputId: "input-1", sessionId: "session-1", botId: "bot-1", value: "测试" } },
        { tag: "button", value: { kind: "user_input", inputId: "input-1", sessionId: "session-1", botId: "bot-1", value: "生产" } },
      ],
    });
    expect(buildUserInputCard({
      inputId: "input-2",
      sessionId: "session-1",
      botId: "bot-1",
      prompt: "请输入名称",
      options: [],
    }).elements?.[1]).toMatchObject({ tag: "note" });
  });

  it("EventDispatcher 将 card.action.trigger 的 action.value 透传给回调", async () => {
    const onCardAction = vi.fn(async () => ({ toast: { type: "success", content: "ok" } }));
    const dispatcher = createDispatcher(feishuConfig(), { onMessage: vi.fn(), onCardAction });
    const response = await invokeWebhook(dispatcher, {
      schema: "2.0",
      header: { event_type: "card.action.trigger" },
      event: {
        action: {
          tag: "button",
          value: { kind: "approval", approvalId: "approval-1", decision: "approve" },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledWith(expect.objectContaining({
      action: { tag: "button", value: { kind: "approval", approvalId: "approval-1", decision: "approve" } },
    }));
    expect(response).toEqual({ toast: { type: "success", content: "ok" } });
  });
});

function feishuConfig(): BotFeishuConfig {
  return {
    enabled: true,
    app_id: "app",
    app_secret: "secret",
    token: null,
    encoding_aes_key: null,
    receive_mode: "webhook",
    route_token: null,
    default_chat_id: null,
  };
}
