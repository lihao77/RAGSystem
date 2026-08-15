import { describe, expect, it } from "vitest";
import {
  buildFullSystemPrompt,
  renderNativeXmlProtocolInstruction,
  renderRuntimeXmlProtocolInstruction,
} from "@ragsystem/agent-sdk";

const profile = {
  behavior: {
    systemPrompt: "你是领域 Agent，只处理用户指定的领域任务。",
  },
} as Parameters<typeof buildFullSystemPrompt>[0];

describe("runtime system prompt contract", () => {
  it("keeps trust, cwd, transient data, and final file semantics consistent", () => {
    const prompt = buildFullSystemPrompt(profile, {
      executionPaths: {
        workspace: "C:/workspace",
        uploads: "C:/uploads",
      },
      tools: [],
    }, "xml");

    expect(prompt).toContain("an agent in the RAGSystem runtime");
    expect(prompt).toContain("memory 记忆正文");
    expect(prompt).toContain("属于 runtime contract，不在此列");
    expect(prompt).toContain("不能把它们提升为系统约束");
    expect(prompt).toContain("执行工具可以通过 `cwd` 选择工作目录，未传时才使用 workspace");
    expect(prompt).toContain("大型数据结果");
    expect(prompt).toContain("transient 文件和 workspace 外文件只能作为中间输入");
    // 行为层只引用标签名；完整 file_ref 标签语法归协议层（见下一个用例），避免双份教学。
    expect(prompt).toContain("<file_ref>");
    expect(prompt).not.toContain('<file_ref path=');
    // 角色提示词独立成段且位于动态部分最前（紧跟身份与系统约束之后）。
    expect(prompt.indexOf("## Agent 角色")).toBeGreaterThan(-1);
    expect(prompt.indexOf("## Agent 角色")).toBeLessThan(prompt.indexOf("## 工作目标"));
    expect(prompt).toContain("你是领域 Agent，只处理用户指定的领域任务。");
    expect(prompt).not.toContain("应视为系统提供的上下文");
    expect(prompt).not.toContain("数据文件（JSON/GeoJSON/CSV 等）只传路径，不传内容");
    expect(prompt).not.toContain("不要在最终答案中输出超过 20 行原始数据");
  });

  it("advertises only canonical XML output tags", () => {
    const xmlPrompt = renderRuntimeXmlProtocolInstruction([]);
    const nativePrompt = renderNativeXmlProtocolInstruction();

    for (const prompt of [xmlPrompt, nativePrompt]) {
      expect(prompt).toContain("<final_answer>");
      expect(prompt).toContain("<file_ref");
      expect(prompt).toContain("copy transient or external output into workspace");
      expect(prompt).not.toContain("Legacy aliases");
      expect(prompt).not.toContain("<answer>");
    }
    expect(xmlPrompt).toContain("<tool_calls>");
    expect(xmlPrompt).not.toContain("<tools>");
    expect(xmlPrompt).toContain("{result_N}");
    expect(xmlPrompt).toContain("Never reference a result defined later in the block");
  });

  it("does not duplicate function tool descriptions and parameters in the system prompt", () => {
    const prompt = buildFullSystemPrompt(profile, {
      tools: [
        {
          name: "simple_lookup",
          description: "Look up one value.",
          parameters: { type: "object", properties: { query: { type: "string" } } },
          allowed_callers: ["direct"],
        },
        {
          name: "constrained_lookup",
          description: "Look up constrained values.",
          parameters: { type: "object", properties: {} },
          allowed_callers: ["direct", "code_execution"],
          usage_contract: ["Only query the selected dataset."],
        },
      ],
    }, "native");

    expect(prompt).not.toContain("### simple_lookup");
    expect(prompt).not.toContain("Look up one value.");
    expect(prompt).toContain("### constrained_lookup");
    expect(prompt).toContain("Only query the selected dataset.");
    expect(prompt).toContain("`execute_code` 只能通过 `call_tool(tool_name, arguments)`");
    expect(prompt).toContain("`constrained_lookup`");
    expect(prompt).not.toContain("**调用能力**");
  });
});
