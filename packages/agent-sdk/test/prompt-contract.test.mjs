import assert from "node:assert/strict";
import test from "node:test";

import { buildFullSystemPrompt } from "../dist/index.js";
import {
  renderNativeXmlProtocolInstruction,
  renderRuntimeXmlProtocolInstruction,
} from "../dist/llm-protocol/xml/rendering.js";

/**
 * prompt 行为契约基线（结构特征断言，非全文匹配）。
 * 锁住的分工：语言/排版/行为规则的权威在框架层（src/prompt/sections.ts），
 * 输出形态与标签语法教学的权威在协议层（src/llm-protocol/xml/rendering.ts）。
 * 有意调整分层时同步更新本文件——测试失败意味着改动需要重新权衡，而不是静默漂移。
 */

const profile = (systemPrompt) => ({
  behavior: systemPrompt ? { systemPrompt } : {},
});

const minimalTool = {
  name: "read_file",
  description: "读取文件内容",
  parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
};

const fullPrompt = buildFullSystemPrompt(
  profile("你是测试助手。"),
  { tools: [minimalTool], executionPaths: { workspace: "/data/ws", uploads: "/data/uploads" } },
  "xml",
);

/** 断言锚点按给定顺序出现（indexOf 严格递增）。 */
const assertInOrder = (text, anchors) => {
  let cursor = -1;
  for (const anchor of anchors) {
    const index = text.indexOf(anchor);
    assert.ok(index > cursor, `锚点 "${anchor}" 应出现在位置 ${cursor} 之后`);
    cursor = index;
  }
};

test("系统提示词各段按固定顺序拼装", () => {
  assertInOrder(fullPrompt, [
    "## 系统约束",
    "## Agent 角色",
    "## 工作目标",
    "## 核心原则",
    "## 执行原则",
    "## 输出效率",
    "## 可见输出排版",
    "## 当前执行目录",
    "## 工具使用",
    "## 数据文件传递规则",
  ]);
});

test("无角色提示词时不渲染 Agent 角色段", () => {
  const prompt = buildFullSystemPrompt(profile(), {});
  assert.ok(!prompt.includes("## Agent 角色"));
  assert.ok(prompt.includes("## 系统约束"));
});

test("语言规则的唯一权威在框架层，协议层不复述", () => {
  assert.ok(fullPrompt.includes("可见文本使用与用户一致的语言"));
  const xmlInstruction = renderRuntimeXmlProtocolInstruction([minimalTool]);
  const nativeInstruction = renderNativeXmlProtocolInstruction();
  assert.ok(!xmlInstruction.includes("user's language"), "XML 协议层不应复述语言规则");
  assert.ok(!nativeInstruction.includes("user's language"), "native 协议层不应复述语言规则");
});

test("协议层保留流式形态事实", () => {
  assert.ok(renderRuntimeXmlProtocolInstruction([minimalTool]).includes("plain text streamed to the user"));
  assert.ok(renderNativeXmlProtocolInstruction().includes("plain text streamed to the user"));
});

test("可见输出排版段声明 GFM、emoji 默认与流式约束", () => {
  for (const anchor of ["GFM Markdown", "emoji", "边生成边呈现", "复述工具调用细节"]) {
    assert.ok(fullPrompt.includes(anchor), `排版段应包含 "${anchor}"`);
  }
});

test("核心原则包含失败与不确定性沟通规范", () => {
  for (const anchor of ["不假装成功", "标注关键假设", "不要只依赖审批提示"]) {
    assert.ok(fullPrompt.includes(anchor), `核心原则应包含 "${anchor}"`);
  }
});

test("用户指定格式的优先级规则仅出现一次（排版段为默认值，不复述优先级）", () => {
  assert.equal(fullPrompt.split("用户指定的格式").length - 1, 1);
});

test("file_ref 行为规则在框架层、语法教学在协议层", () => {
  assert.ok(fullPrompt.includes("不是文件引用"));
  assert.ok(renderRuntimeXmlProtocolInstruction([minimalTool]).includes("are not file references"));
});
