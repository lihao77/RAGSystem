import { describe, expect, it } from "vitest";

import {
  mergeRequestOverrides,
  readSessionRequestOverrides,
  SESSION_REQUEST_OVERRIDES_METADATA_KEY,
} from "../src/services/agent/execution/session-request-overrides.js";

/**
 * 会话级请求覆盖（selected_llm / thinking_level）：会话 metadata 是主智能体
 * default 档设定的唯一持久层——前端选择器变化即时 PATCH、发送路径后端补写，
 * 一切 root run 拉起渠道读回。读取必须形状驱动收敛：前端 PATCH 与后端补写
 * 两路写入、手工编辑等半迁移状态都不能让执行路径爆掉。
 */
describe("readSessionRequestOverrides", () => {
  it("解析合法设定", () => {
    expect(readSessionRequestOverrides({
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: {
        selected_llm: "ali|alibaba|qwen-max",
        thinking_level: "high",
        updated_at: "2026-09-05T00:00:00Z",
      },
    })).toEqual({ selectedLlm: "ali|alibaba|qwen-max", thinkingLevel: "high" });
  });

  it("键缺失 / metadata 为空 → 未设定", () => {
    expect(readSessionRequestOverrides(null)).toEqual({ selectedLlm: null, thinkingLevel: null });
    expect(readSessionRequestOverrides(undefined)).toEqual({ selectedLlm: null, thinkingLevel: null });
    expect(readSessionRequestOverrides({})).toEqual({ selectedLlm: null, thinkingLevel: null });
    expect(readSessionRequestOverrides({ [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: null }))
      .toEqual({ selectedLlm: null, thinkingLevel: null });
  });

  it("畸形形状按未设定收敛（数组/标量/字段类型不符/枚举外档位）", () => {
    expect(readSessionRequestOverrides({ [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: ["x"] }))
      .toEqual({ selectedLlm: null, thinkingLevel: null });
    expect(readSessionRequestOverrides({ [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: "ali|qwen" }))
      .toEqual({ selectedLlm: null, thinkingLevel: null });
    expect(readSessionRequestOverrides({
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: { selected_llm: 42, thinking_level: "ultra" },
    })).toEqual({ selectedLlm: null, thinkingLevel: null });
    // 半好半坏：合法字段保留，坏字段收敛为 null。
    expect(readSessionRequestOverrides({
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: { selected_llm: "ali|qwen-max", thinking_level: [] },
    })).toEqual({ selectedLlm: "ali|qwen-max", thinkingLevel: null });
  });

  it("空白字符串的 selected_llm 视为未设定", () => {
    expect(readSessionRequestOverrides({
      [SESSION_REQUEST_OVERRIDES_METADATA_KEY]: { selected_llm: "   ", thinking_level: null },
    })).toEqual({ selectedLlm: null, thinkingLevel: null });
  });
});

describe("mergeRequestOverrides 三态合并", () => {
  const session = { selectedLlm: "ali|qwen-max", thinkingLevel: "high" as const };

  it("请求未携带（undefined）→ 继承会话设定", () => {
    expect(mergeRequestOverrides({}, session)).toEqual(session);
  });

  it("显式 null → 清除（回落 agent tier 默认）", () => {
    expect(mergeRequestOverrides({ selectedLlm: null, thinkingLevel: null }, session))
      .toEqual({ selectedLlm: null, thinkingLevel: null });
  });

  it("有值 → 生效（空串模型按清除收敛）", () => {
    expect(mergeRequestOverrides({ selectedLlm: "pqy|glm-5", thinkingLevel: "off" }, session))
      .toEqual({ selectedLlm: "pqy|glm-5", thinkingLevel: "off" });
    expect(mergeRequestOverrides({ selectedLlm: "  " }, session))
      .toEqual({ selectedLlm: null, thinkingLevel: "high" });
  });

  it("会话未设定时 undefined 请求保持未设定", () => {
    expect(mergeRequestOverrides({}, { selectedLlm: null, thinkingLevel: null }))
      .toEqual({ selectedLlm: null, thinkingLevel: null });
  });
});
