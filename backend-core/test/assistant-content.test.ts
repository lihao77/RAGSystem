import { describe, expect, it } from "vitest";
import {
  parseAssistantContent,
  StreamingAssistantContentParser,
  StreamingRuntimeXmlParser,
} from "@ragsystem/agent-sdk";

describe("assistant content normalization", () => {
  it("produces the same canonical parts from streaming chunks and a complete response", () => {
    const source = 'before <file_ref path="results/map.png" presentation="inline" caption="Risk map"/> after';
    const parser = new StreamingAssistantContentParser();
    const events = [
      ...parser.feed("before <fi"),
      ...parser.feed('le_ref path="results/map.png" presentation="inline" caption="Risk map"/> after'),
      ...parser.finish(),
    ];
    const complete = parseAssistantContent(source);

    expect(parser.getParts()).toEqual(complete.parts);
    expect(events).toEqual([
      { type: "text_delta", partIndex: 0, content: "before " },
      {
        type: "file_ref",
        partIndex: 1,
        part: {
          type: "file_ref",
          filePath: "results/map.png",
          presentation: "inline",
          caption: "Risk map",
        },
      },
      { type: "text_delta", partIndex: 2, content: " after" },
    ]);
    expect(complete.content).toContain("results/map.png");
  });

  it("does not turn absolute or traversal paths into file references", () => {
    const source = '<file_ref path="../secret.txt" presentation="attachment"/>';
    const parsed = parseAssistantContent(source);

    expect(parsed.hasFileRefs).toBe(false);
    expect(parsed.parts).toEqual([{ type: "text", text: source }]);
  });

  it("preserves a file marker when the model omits the final_answer wrapper", () => {
    const source = 'before <file_ref path="results/map.png" presentation="inline"/> after';
    const runtimeParser = new StreamingRuntimeXmlParser();
    const fallback = runtimeParser
      .feed(source)
      .filter((event) => event.type === "fallback")
      .map((event) => event.content)
      .join("");

    expect(fallback).toBe(source);
    expect(parseAssistantContent(fallback).parts).toEqual([
      { type: "text", text: "before " },
      { type: "file_ref", filePath: "results/map.png", presentation: "inline" },
      { type: "text", text: " after" },
    ]);
  });

});
