import assert from "node:assert/strict";
import test from "node:test";

import { parseRuntimeToolCallsXml } from "../dist/llm-protocol/xml/tool-calls.js";

test("combines raw control character and bare placeholder repairs", () => {
  const xml = `<tool name="edit"><![CDATA[{"old_string":"before
\tafter","source":{result_1}}]]></tool>`;

  const parsed = parseRuntimeToolCallsXml(xml);

  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.calls, [{
    toolName: "edit",
    arguments: {
      old_string: "before\n\tafter",
      source: "{result_1}",
    },
  }]);
});

test("combines object extraction with all argument repairs", () => {
  const backslash = "\\";
  const xml = `<tool name="edit"><![CDATA[prefix {"path":"C:${backslash}workspace${backslash}project.txt","old_string":"first
second","source":{result_2.value}} suffix]]></tool>`;

  const parsed = parseRuntimeToolCallsXml(xml);

  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.calls, [{
    toolName: "edit",
    arguments: {
      path: "C:/workspace/project.txt",
      old_string: "first\nsecond",
      source: "{result_2.value}",
    },
  }]);
});
