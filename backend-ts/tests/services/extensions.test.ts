import { describe, expect, it, vi } from "vitest";
import { extractText, type ChatMessage, type ContentPart } from "@ragsystem/agent-llm";

import { projectConversationExtensions } from "../../src/services/agent/context/extensions/project.js";
import { normalizeExtensions } from "../../src/services/agent/context/extensions/normalize.js";
import { ProjectionRegistry } from "../../src/services/agent/context/extensions/registry.js";
import { attachmentsProjector, renderAttachmentsContext } from "../../src/services/agent/context/extensions/attachments-projector.js";
import { uiContextProjector, renderUiContextText } from "../../src/services/agent/context/extensions/ui-context-projector.js";
import { toolResultMediaProjector } from "../../src/services/agent/context/extensions/tool-result-media-projector.js";
import { microcompactHistoryMessages } from "../../src/services/agent/context/history-view.js";

function makeRegistry(): ProjectionRegistry {
  const registry = new ProjectionRegistry();
  registry.register(attachmentsProjector);
  registry.register(uiContextProjector);
  registry.register(toolResultMediaProjector);
  return registry;
}

const IMAGE = {
  file_id: "file-image",
  original_name: "a.png",
  stored_name: "file-image_a.png",
  mime: "image/png",
  size: 4,
  kind: "image" as const,
};
const FILE = {
  file_id: "file-data",
  original_name: "a&b.csv",
  stored_name: "file-data_a_b.csv",
  mime: "text/csv",
  size: 12,
  kind: "file" as const,
};
const TOOL_IMAGE = { kind: "image", stored_path: "/p/a.png", mime: "image/png", original_name: "a.png" };

function projectionContext(overrides: {
  supportsVision?: boolean;
  readAttachment?: (sessionId: string, fileId: string) => Promise<{ body: Uint8Array; contentType: string | null } | null>;
  readToolImage?: (storedPath: string, mime: string) => string | null;
} = {}) {
  return {
    sessionId: "s1",
    supportsVision: overrides.supportsVision ?? true,
    readAttachment: overrides.readAttachment ?? (async () => null),
    readToolImage: overrides.readToolImage ?? (() => null),
  };
}

describe("projectConversationExtensions", () => {
  it("attachments extension 注入文件清单并把 SaaS/Local reader 返回的图片转为 image_url", async () => {
    const readAttachment = vi.fn(async () => ({ body: Uint8Array.from([1, 2, 3]), contentType: "image/png" }));
    const conversation: ChatMessage[] = [{ role: "user", content: "看这张图" }];
    const raw = [{
      role: "user",
      metadata: { extensions: [{ kind: "attachments", version: 1, data: { items: [IMAGE] } }] },
    }];

    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext({ readAttachment }));

    const parts = conversation[0]!.content as ContentPart[];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({ type: "text", text: "看这张图" });
    expect(parts[1]).toMatchObject({ type: "text", text: expect.stringContaining("<attachments version=\"1\">") });
    expect(parts[2]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
    expect(readAttachment).toHaveBeenCalledWith("s1", "file-image");
    expect(extractText(parts)).toContain("<attachments version=\"1\">");
    expect(extractText(parts)).not.toContain("[图片]");
  });

  it("普通文件与不支持视觉的图片仍以 uploads 逻辑路径进入上下文", async () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "处理附件" }];
    const raw = [{
      role: "user",
      metadata: { extensions: [{ kind: "attachments", version: 1, data: { items: [IMAGE, FILE] } }] },
    }];

    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext({ supportsVision: false }));

    expect(conversation[0]!.content).toContain("处理附件");
    expect(conversation[0]!.content).toContain('file_path="file-image_a.png"');
    expect(conversation[0]!.content).toContain('file_path_space="uploads"');
    expect(conversation[0]!.content).toContain('name="a&amp;b.csv"');
  });

  it("图片读取失败时保留附件清单并追加明确占位", async () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "看图" }];
    const raw = [{ role: "user", metadata: { extensions: [{ kind: "attachments", version: 1, data: { items: [IMAGE] } }] } }];
    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext());
    const parts = conversation[0]!.content as ContentPart[];
    expect(parts.some((part) => part.type === "text" && part.text.includes("<attachments"))).toBe(true);
    expect(parts.some((part) => part.type === "text" && part.text.includes("[图片加载失败:a.png]"))).toBe(true);
  });

  it("拒绝缺少版本或版本错误的 attachments 扩展", async () => {
    for (const extension of [
      { kind: "attachments", data: { items: [FILE] } },
      { kind: "attachments", version: 2, data: { items: [FILE] } },
    ]) {
      const conversation: ChatMessage[] = [{ role: "user", content: "处理附件" }];
      const raw = [{ role: "user", metadata: { extensions: [extension] } }];
      await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext());
      expect(conversation[0]!.content).toBe("处理附件");
    }
  });

  it("ui_context extension 追加到用户文本", async () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "这个怎么办" }];
    const raw = [{ role: "user", metadata: { extensions: [{ kind: "ui_context", data: { entries: [{ label: "当前视图", value: "订单详情" }] } }] } }];
    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext());
    expect(conversation[0]!.content).toBe("这个怎么办\n<ui_context>\n- 当前视图: 订单详情\n</ui_context>");
  });

  it("无扩展消息 content 不变", async () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "纯文本" }, { role: "assistant", content: "回复" }];
    const raw = [{ role: "user", metadata: {} }, { role: "assistant", metadata: {} }];
    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext());
    expect(conversation[0]!.content).toBe("纯文本");
    expect(conversation[1]!.content).toBe("回复");
  });

  it("tool_result_media 仍从瞬态路径恢复工具图片", async () => {
    const conversation: ChatMessage[] = [{ role: "tool", tool_call_id: "t1", content: "截图完成" }];
    const raw = [{ role: "tool", metadata: { extensions: [{ kind: "tool_result_media", data: { media: [TOOL_IMAGE] } }] } }];
    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext({
      readToolImage: () => "data:image/png;base64,AAAA",
    }));
    expect(conversation[0]?.content).toEqual([
      { type: "text", text: "截图完成" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
    ]);
  });

  it("microcompact 清理后不恢复工具媒体", async () => {
    const conversation: ChatMessage[] = [{ role: "tool", content: "历史工具结果不可用" }];
    const raw = [{
      role: "tool",
      metadata: { microcompact_cleared: true, extensions: [{ kind: "tool_result_media", data: { media: [TOOL_IMAGE] } }] },
    }];
    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext({
      readToolImage: () => "data:image/png;base64,AAAA",
    }));
    expect(conversation[0]?.content).toBe("历史工具结果不可用");
  });

  it("attachments 与 ui_context 共存且顺序不影响文本投影", async () => {
    const conversation: ChatMessage[] = [{ role: "user", content: "结合上下文处理" }];
    const raw = [{
      role: "user",
      metadata: {
        extensions: [
          { kind: "attachments", version: 1, data: { items: [IMAGE] } },
          { kind: "ui_context", data: { entries: [{ label: "视图", value: "订单" }] } },
        ],
      },
    }];
    await projectConversationExtensions(conversation, raw, makeRegistry(), projectionContext({
      readAttachment: async () => ({ body: Uint8Array.from([1]), contentType: "image/png" }),
    }));
    const parts = conversation[0]!.content as ContentPart[];
    expect(parts.some((part) => part.type === "image_url")).toBe(true);
    const text = parts.filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
    expect(text).toContain("结合上下文处理");
    expect(text).toContain("<attachments");
    expect(text).toContain("<ui_context>");
  });
});

describe("microcompact tool media marker", () => {
  it("marks cleared observation metadata for extension projection", () => {
    const messages = [1, 2].map((seq) => ({
      id: `m${seq}`,
      session_id: "s1",
      seq,
      role: "tool" as const,
      content: `tool result ${seq}`,
      metadata: { msg_type: "observation", extensions: [{ kind: "tool_result_media", data: { media: [TOOL_IMAGE] } }] },
      created_at: "2026-07-11T00:00:00.000Z",
      thread_key: "root",
      child_agent_id: null,
      tool_call_id: `t${seq}`,
      name: "screenshot",
    }));
    const compacted = microcompactHistoryMessages(messages, 1);
    expect(compacted.messages[0]?.metadata.microcompact_cleared).toBe(true);
    expect(compacted.messages[1]?.metadata.microcompact_cleared).toBeUndefined();
  });
});

describe("attachment extension helpers", () => {
  it("normalizeExtensions only reads the canonical extensions array", () => {
    const extensions = [{ kind: "attachments" as const, version: 1, data: { items: [FILE] } }];
    expect(normalizeExtensions({ extensions })).toBe(extensions);
    expect(normalizeExtensions(null)).toEqual([]);
  });

  it("renderAttachmentsContext escapes XML and exposes only logical uploads paths", () => {
    const text = renderAttachmentsContext([FILE]);
    expect(text).toContain('name="a&amp;b.csv"');
    expect(text).toContain('file_path="file-data_a_b.csv"');
    expect(text).toContain('file_path_space="uploads"');
    expect(text).not.toContain("stored_path");
  });
});

describe("renderUiContextText", () => {
  it("空 entries 返回空串", () => {
    expect(renderUiContextText({ entries: [] })).toBe("");
    expect(renderUiContextText({})).toBe("");
  });

  it("entries 渲染 label: value(+detail)", () => {
    const text = renderUiContextText({ entries: [{ label: "视图", value: "看板", detail: "Q3" }] });
    expect(text).toContain("- 视图: 看板(Q3)");
  });
});
