import { describe, expect, it } from "vitest";
import type { ChatMessage, ContentPart } from "@ragsystem/agent-llm";

import { projectConversationExtensions } from "../../src/services/agent/context/extensions/project.js";
import { normalizeExtensions } from "../../src/services/agent/context/extensions/normalize.js";
import { ProjectionRegistry } from "../../src/services/agent/context/extensions/registry.js";
import { imageAttachmentProjector } from "../../src/services/agent/context/extensions/image-attachment-projector.js";
import { uiContextProjector, renderUiContextText } from "../../src/services/agent/context/extensions/ui-context-projector.js";

function makeRegistry(): ProjectionRegistry {
  const r = new ProjectionRegistry();
  r.register(imageAttachmentProjector);
  r.register(uiContextProjector);
  return r;
}

const IMG = { kind: "image", stored_path: "/p/a.png", mime: "image/png", original_name: "a.png" };

describe("projectConversationExtensions", () => {
  it("image_attachment extension → image_url part(vision 支持)", () => {
    const registry = makeRegistry();
    const conversation: ChatMessage[] = [{ role: "user", content: "看这张图" }];
    const raw = [{
      role: "user",
      metadata: { extensions: [{ kind: "image_attachment", data: { attachments: [IMG] } }] },
    }];
    projectConversationExtensions(conversation, raw, registry, {
      supportsVision: true,
      readImage: () => "data:image/png;base64,AAAA",
    });
    const parts = conversation[0]!.content as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: "看这张图" });
    expect(parts[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("supportsVision=false → 图片降级文本占位(ContentPart[]:原文本 + 占位)", () => {
    const registry = makeRegistry();
    const conversation: ChatMessage[] = [{ role: "user", content: "图呢" }];
    const raw = [{
      role: "user",
      metadata: { extensions: [{ kind: "image_attachment", data: { attachments: [IMG] } }] },
    }];
    projectConversationExtensions(conversation, raw, registry, {
      supportsVision: false,
      readImage: () => "data:image/png;base64,BBBB",
    });
    const parts = conversation[0]!.content as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: "text", text: "图呢" });
    expect(parts[1]).toMatchObject({ type: "text", text: "[图片:a.png(当前模型不支持图片识别)]" });
  });

  it("ui_context extension → <ui_context> 文本追加 content", () => {
    const registry = makeRegistry();
    const conversation: ChatMessage[] = [{ role: "user", content: "这个怎么办" }];
    const raw = [{
      role: "user",
      metadata: { extensions: [{ kind: "ui_context", data: { entries: [{ label: "当前视图", value: "订单详情" }] } }] },
    }];
    projectConversationExtensions(conversation, raw, registry, { supportsVision: true, readImage: () => null });
    expect(conversation[0]!.content).toBe("这个怎么办\n<ui_context>\n- 当前视图: 订单详情\n</ui_context>");
  });

  it("无扩展消息 content 不变(assistant 不投影)", () => {
    const registry = makeRegistry();
    const conversation: ChatMessage[] = [
      { role: "user", content: "纯文本" },
      { role: "assistant", content: "回复" },
    ];
    const raw = [{ role: "user", metadata: {} }, { role: "assistant", metadata: {} }];
    projectConversationExtensions(conversation, raw, registry, { supportsVision: true, readImage: () => null });
    expect(conversation[0]!.content).toBe("纯文本");
    expect(conversation[1]!.content).toBe("回复");
  });

  it("image_attachment + ui_context 共存:文本 + ui_context 文本 + image parts 都进 content", () => {
    const registry = makeRegistry();
    const conversation: ChatMessage[] = [{ role: "user", content: "看图参考上下文" }];
    const raw = [{
      role: "user",
      metadata: {
        extensions: [
          { kind: "ui_context", data: { entries: [{ label: "视图", value: "订单" }] } },
          { kind: "image_attachment", data: { attachments: [IMG] } },
        ],
      },
    }];
    projectConversationExtensions(conversation, raw, registry, { supportsVision: true, readImage: () => "data:image/png;base64,X" });
    // ui_context 先投影(string 追加,content 变字符串);image_attachment 后投影(array,mergeParts 转 ContentPart[])
    const parts = conversation[0]!.content as ContentPart[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p) => p.type === "image_url")).toBe(true);
    const textPart = parts.find((p) => p.type === "text") as { text: string } | undefined;
    expect(textPart).toBeTruthy();
    expect(textPart!.text).toContain("看图参考上下文");
    expect(textPart!.text).toContain("<ui_context>");
  });
});

describe("normalizeExtensions", () => {
  it("extensions 优先,有则直接返回", () => {
    const ext = [{ kind: "ui_context" as const, data: {} }];
    expect(normalizeExtensions({ extensions: ext })).toBe(ext);
  });

  it("无 extensions 返回空数组(写入侧已统一,不读 metadata.attachments)", () => {
    expect(normalizeExtensions({ attachments: [IMG] })).toEqual([]);
    expect(normalizeExtensions(null)).toEqual([]);
    expect(normalizeExtensions(undefined)).toEqual([]);
  });

  it("混合老数据(extensions + attachments 共存)只返 extensions,不读 attachments", () => {
    const ext = [{ kind: "ui_context" as const, data: {} }];
    const r = normalizeExtensions({ extensions: ext, attachments: [IMG] });
    expect(r).toBe(ext);
    expect(r).toHaveLength(1);
  });
});

describe("renderUiContextText", () => {
  it("空 entries 返回空串", () => {
    expect(renderUiContextText({ entries: [] })).toBe("");
    expect(renderUiContextText({})).toBe("");
  });

  it("entries 渲染 label: value(+detail)", () => {
    const txt = renderUiContextText({ entries: [{ label: "视图", value: "看板", detail: "Q3" }] });
    expect(txt.startsWith("<ui_context>")).toBe(true);
    expect(txt).toContain("- 视图: 看板(Q3)");
  });
});
