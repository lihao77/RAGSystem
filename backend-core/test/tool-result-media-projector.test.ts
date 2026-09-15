import { describe, expect, it, vi } from "vitest";

import type { MessageExtension } from "../src/services/agent/context/extensions/kinds.js";
import { toolResultMediaProjector } from "../src/services/agent/context/extensions/tool-result-media-projector.js";

function baseCtx(overrides: Partial<Parameters<typeof toolResultMediaProjector.project>[1]> = {}) {
  return {
    role: "tool",
    sessionId: "session-1",
    supportsVision: true,
    readAttachment: vi.fn(),
    readToolImage: vi.fn(() => null),
    ...overrides,
  };
}

function mediaExtension(entries: Array<Record<string, unknown>>): MessageExtension {
  return { kind: "tool_result_media", data: { media: entries } };
}

describe("toolResultMediaProjector", () => {
  it("prefers the session attachment channel for file_id entries and honors the variant content type", async () => {
    const readAttachment = vi.fn().mockResolvedValue({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
    });
    const readToolImage = vi.fn(() => "data:image/png;base64,AAA");
    const parts = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", file_id: "file-1", stored_path: "D:/tmp/old.png", mime: "image/png" }]),
      baseCtx({ readAttachment, readToolImage }),
    );

    expect(readAttachment).toHaveBeenCalledWith("session-1", "file-1");
    expect(readToolImage).not.toHaveBeenCalled();
    const image = (parts as Array<{ type: string; image_url?: { url: string } }>).find((part) => part.type === "image_url");
    // 变体可能换编码：data URL 的 mime 跟随读取结果 contentType，而非存量 mime 声明
    expect(image?.image_url?.url.startsWith("data:image/webp;base64,")).toBe(true);
  });

  it("falls back to the legacy stored_path reader when file_id is missing or the attachment read fails", async () => {
    const readAttachment = vi.fn().mockResolvedValue(null);
    const readToolImage = vi.fn(() => "data:image/jpeg;base64,BBB");

    const legacy = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", stored_path: "D:/tmp/old.jpg", mime: "image/jpeg" }]),
      baseCtx({ readToolImage }),
    );
    expect(readAttachment).not.toHaveBeenCalled();
    expect((legacy as Array<{ type: string; image_url?: { url: string } }>)[0]?.image_url?.url).toBe("data:image/jpeg;base64,BBB");

    const unreadable = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", file_id: "file-gone", stored_path: "D:/tmp/old2.jpg", mime: "image/jpeg" }]),
      baseCtx({ readAttachment, readToolImage }),
    );
    expect(readAttachment).toHaveBeenCalledWith("session-1", "file-gone");
    expect((unreadable as Array<{ type: string; image_url?: { url: string } }>)[0]?.image_url?.url).toBe("data:image/jpeg;base64,BBB");
  });

  it("degrades to a text placeholder when both channels fail or the model lacks vision", async () => {
    const parts = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", file_id: "file-1", stored_path: "D:/tmp/x.png", mime: "image/png", original_name: "shot.png" }]),
      baseCtx({ readAttachment: vi.fn().mockRejectedValue(new Error("boom")) }),
    );
    expect((parts as Array<{ type: string; text?: string }>)[0]?.text).toContain("工具图片已过期或加载失败:shot.png");

    const textOnly = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", stored_path: "D:/tmp/x.png", mime: "image/png" }]),
      baseCtx({ supportsVision: false }),
    );
    expect((textOnly as Array<{ type: string; text?: string }>)[0]?.text).toContain("当前模型不支持图片识别");
  });
});
