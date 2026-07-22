import { describe, expect, it } from "vitest";
import type { ContentPart } from "@ragsystem/agent-llm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import {
  AgentContextBuilder,
  RecentMessagesContextSource,
  createDefaultProjectionRegistry,
} from "../../src/services/agent/context/index.js";

/**
 * Extension 端到端投影(store → conversation):验证 user 消息的 metadata.extensions[]
 * 经 RecentMessagesContextSource + createDefaultProjectionRegistry 装配后,投影进 LLM content。
 * extensions.test.ts 测投影纯函数;本文件覆盖"装配 + store 读取"链路。
 */
describe("ui_context 端到端投影(store → conversation)", () => {
  it("user 消息 extensions[ui_context] 投影成 <ui_context> 文本追加到 content", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s1", null);
    store.addMessage({
      sessionId: "s1",
      role: "user",
      content: "这个怎么办",
      threadKey: "root",
      metadata: {
        extensions: [
          { kind: "ui_context", data: { entries: [{ key: "current_view", label: "当前页面", value: "知识库" }] } },
        ],
      },
    });

    const historyPort = {
      getRecentMessages: async (sid: string, limit?: number, tk?: string | null) =>
        store.getRecentMessages(sid, limit ?? 10_000, tk ?? "root"),
    };
    const registry = createDefaultProjectionRegistry();
    const source = new RecentMessagesContextSource(historyPort, true, registry);
    const builder = new AgentContextBuilder([source]);

    const ctx = await builder.buildContext({ sessionId: "s1", threadKey: "root" }, { touch: false });
    const userMsg = ctx.conversation.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    const content = typeof userMsg!.content === "string" ? userMsg!.content : "";
    expect(content).toContain("这个怎么办");
    expect(content).toContain("<ui_context>");
    expect(content).toContain("- 当前页面: 知识库");
  });

  it("老消息 metadata.ui_context(无 extensions)不被投影(仅 extensions[] 投影)", async () => {
    // 佐证:只有 extensions[] 形态才投影;散落的 metadata.ui_context 不进 LLM(写入侧须落 extensions[])
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s2", null);
    store.addMessage({
      sessionId: "s2",
      role: "user",
      content: "纯文本",
      threadKey: "root",
      metadata: { ui_context: { entries: [{ label: "x", value: "y" }] } },
    });
    const historyPort = {
      getRecentMessages: async (sid: string, limit?: number, tk?: string | null) =>
        store.getRecentMessages(sid, limit ?? 10_000, tk ?? "root"),
    };
    const source = new RecentMessagesContextSource(historyPort, true, createDefaultProjectionRegistry());
    const ctx = await new AgentContextBuilder([source]).buildContext({ sessionId: "s2", threadKey: "root" }, { touch: false });
    const userMsg = ctx.conversation.find((m) => m.role === "user");
    const content = typeof userMsg?.content === "string" ? userMsg.content : "";
    expect(content).toBe("纯文本");
  });
});

describe("image_attachment 端到端投影(store → conversation)", () => {
  it("user 消息 extensions[image_attachment] 经装配投影进 content(读盘失败降级文本占位)", async () => {
    // recent-source 内部硬编码 fs 读盘,无法注入 mock;此处用不存在路径走降级,验证装配链路通。
    // image_url 主路径(data URL 生成)在 extensions.test.ts 纯函数测试以 readImage mock 覆盖。
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "s3", null);
    store.addMessage({
      sessionId: "s3",
      role: "user",
      content: "看这张图",
      threadKey: "root",
      metadata: {
        extensions: [
          {
            kind: "image_attachment",
            data: { attachments: [{ kind: "image", stored_path: "/nonexistent/a.png", mime: "image/png", original_name: "a.png" }] },
          },
        ],
      },
    });

    const historyPort = {
      getRecentMessages: async (sid: string, limit?: number, tk?: string | null) =>
        store.getRecentMessages(sid, limit ?? 10_000, tk ?? "root"),
    };
    const source = new RecentMessagesContextSource(historyPort, true, createDefaultProjectionRegistry());
    const ctx = await new AgentContextBuilder([source]).buildContext({ sessionId: "s3", threadKey: "root" }, { touch: false });
    const userMsg = ctx.conversation.find((m) => m.role === "user");
    expect(userMsg).toBeTruthy();
    const parts = userMsg!.content as ContentPart[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text.includes("[图片加载失败"))).toBe(true);
  });
});

describe("tool_result_media TTL projection", () => {
  it("does not reuse cached base64 after a transient tool image is deleted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-tool-media-history-"));
    const imagePath = path.join(root, "image.png");
    fs.writeFileSync(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      store.createSession(LOCAL_TENANT_ID, "s-tool-image", null);
      store.addMessage({
        sessionId: "s-tool-image",
        role: "assistant",
        content: "",
        threadKey: "root",
        toolCalls: [{ id: "t1", type: "function", function: { name: "screenshot", arguments: "{}" } }],
        metadata: { msg_type: "intent", run_id: "r1" },
      });
      store.addMessage({
        sessionId: "s-tool-image",
        role: "tool",
        content: "截图完成",
        threadKey: "root",
        toolCallId: "t1",
        name: "screenshot",
        metadata: {
          msg_type: "observation",
          extensions: [{ kind: "tool_result_media", data: { media: [{ kind: "image", stored_path: imagePath, mime: "image/png" }] } }],
        },
      });
      const historyPort = {
        getRecentMessages: async (sid: string, limit?: number, tk?: string | null) => store.getRecentMessages(sid, limit ?? 10_000, tk ?? "root"),
      };
      const source = new RecentMessagesContextSource(historyPort, true, createDefaultProjectionRegistry());

      const first = await new AgentContextBuilder([source]).buildContext({ sessionId: "s-tool-image", threadKey: "root" }, { touch: false });
      expect((first.conversation[1]?.content as ContentPart[]).some((part) => part.type === "image_url")).toBe(true);
      fs.rmSync(imagePath);
      const second = await new AgentContextBuilder([source]).buildContext({ sessionId: "s-tool-image", threadKey: "root" }, { touch: false });
      expect((second.conversation[1]?.content as ContentPart[]).some((part) => part.type === "text" && part.text.includes("已过期或加载失败"))).toBe(true);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
