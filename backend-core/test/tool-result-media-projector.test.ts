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
  it("allows normalized tool-image metadata whose encoding differs from the original file extension", async () => {
    const parts = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", file_id: "normalized", stored_path: "D:/tmp/original.png", original_name: "original.png", mime: "image/jpeg" }]),
      baseCtx({ readAttachment: vi.fn().mockResolvedValue({ body: Buffer.from([0xff, 0xd8, 0xff]), contentType: "image/jpeg" }) }),
    );
    expect((parts as Array<{ type: string }>).some(part => part.type === "image_url")).toBe(true);
  });

  it("prefers the session attachment channel for file_id entries and honors the variant content type", async () => {
    const readAttachment = vi.fn().mockResolvedValue({
      body: Buffer.from("524946460400000057454250", "hex"),
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
    const jpegUrl = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff]).toString("base64")}`;
    const readToolImage = vi.fn(() => jpegUrl);

    const legacy = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", stored_path: "D:/tmp/old.jpg", mime: "image/jpeg" }]),
      baseCtx({ readToolImage }),
    );
    expect(readAttachment).not.toHaveBeenCalled();
    expect((legacy as Array<{ type: string; image_url?: { url: string } }>)[0]?.image_url?.url).toBe(jpegUrl);

    const unreadable = await toolResultMediaProjector.project(
      mediaExtension([{ kind: "image", file_id: "file-gone", stored_path: "D:/tmp/old2.jpg", mime: "image/jpeg" }]),
      baseCtx({ readAttachment, readToolImage }),
    );
    expect(readAttachment).toHaveBeenCalledWith("session-1", "file-gone");
    expect((unreadable as Array<{ type: string; image_url?: { url: string } }>)[0]?.image_url?.url).toBe(jpegUrl);
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

  it("does not re-inline unsupported historical tool images or mislabeled bytes", async () => {
    for (const mime of ["image/tiff", "image/png"]) {
      const parts = await toolResultMediaProjector.project(
        mediaExtension([{ kind: "image", file_id: "file-1", stored_path: "D:/tmp/old.png", mime }]),
        baseCtx({ readAttachment: vi.fn().mockResolvedValue({ body: Buffer.from("49492a0008000000", "hex"), contentType: mime }) }),
      );
      expect((parts as Array<{ type: string }>).some(part => part.type === "image_url")).toBe(false);
    }
  });
});
