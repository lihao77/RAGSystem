import { describe, expect, it } from "vitest";

import { buildDelegatedTask } from "../src/services/agent/delegation/helpers.js";

describe("delegated task default result contract", () => {
  it("appends the result contract after the bare task", () => {
    const task = buildDelegatedTask("调研依赖冲突", null);

    expect(task).toContain("调研依赖冲突");
    expect(task).toContain("[Result Contract]");
    // 三段默认结构：结论 / 产物 / 风险，产物与风险允许省略。
    expect(task).toContain("结论");
    expect(task).toContain("产物");
    expect(task).toContain("风险");
    // 契约必须声明优先级：父 Agent 另行指定格式时以其为准。
    expect(task).toContain("未另行指定输出格式时");
  });

  it("keeps task, context hint and contract in order", () => {
    const task = buildDelegatedTask("汇总模块指标", "只要表格，不要长文");

    expect(task.indexOf("汇总模块指标")).toBeLessThan(task.indexOf("[Context Hint]"));
    expect(task.indexOf("[Context Hint]")).toBeLessThan(task.indexOf("[Result Contract]"));
    expect(task).toContain("只要表格，不要长文");
  });
});
