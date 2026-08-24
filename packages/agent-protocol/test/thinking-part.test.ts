import { describe, expect, it } from "vitest";

import { MessageContentPartSchema } from "../src/protocol.js";

describe("thinking content part", () => {
  it("accepts a thinking part with optional round and complete flags", () => {
    const part = MessageContentPartSchema.parse({
      type: "thinking",
      text: "推理全文",
      round: 2,
      complete: false,
    });
    expect(part).toEqual({ type: "thinking", text: "推理全文", round: 2, complete: false });
  });

  it("accepts a minimal thinking part (text only)", () => {
    expect(MessageContentPartSchema.parse({ type: "thinking", text: "" })).toEqual({
      type: "thinking",
      text: "",
    });
  });

  it("rejects unknown fields (strict)", () => {
    expect(() => MessageContentPartSchema.parse({ type: "thinking", text: "x", signature: "sig" }))
      .toThrow();
  });

  it("rejects non-string text", () => {
    expect(() => MessageContentPartSchema.parse({ type: "thinking", text: 42 })).toThrow();
  });
});
