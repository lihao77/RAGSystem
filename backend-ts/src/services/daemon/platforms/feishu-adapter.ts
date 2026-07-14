import * as lark from "@larksuiteoapi/node-sdk";

import type { PlatformConnection } from "../../../contracts/daemon.js";

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
}

export type FeishuClient = lark.Client;
export type FeishuDispatcher = lark.EventDispatcher;

export interface FeishuLongConnectionHandle {
  started: Promise<void>;
  close(): void;
}

export function createFeishuClient(connection: PlatformConnection): FeishuClient {
  if (!connection.app_id || !connection.app_secret) {
    throw new Error("飞书 app_id/app_secret 未配置");
  }
  return new lark.Client({
    appId: connection.app_id,
    appSecret: connection.app_secret,
  });
}

export function createDispatcher(connection: PlatformConnection, handlers: FeishuHandlers): FeishuDispatcher {
  return new lark.EventDispatcher({
    ...(connection.encoding_aes_key ? { encryptKey: connection.encoding_aes_key } : {}),
    ...(connection.token ? { verificationToken: connection.token } : {}),
  }).register({
    "im.message.receive_v1": handlers.onMessage,
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
