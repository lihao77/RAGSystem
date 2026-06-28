import { describe, expect, it } from "vitest";

import { HostToolRegistry } from "../../src/services/runtime/host-tool-registry.js";
import type { DelegatedToolDeclarationWire } from "../../src/contracts/events.js";

describe("HostToolRegistry", () => {
  it("register 覆盖式替换本 session 全量清单", () => {
    const registry = new HostToolRegistry();
    expect(registry.get("s1")).toEqual([]);
    registry.register("s1", [
      { name: "tool_a", description: "A", input_schema: { type: "object" } },
      { name: "tool_b", description: "B", input_schema: { type: "object" }, risk_level: "high" },
    ]);
    expect(registry.get("s1").map((t) => t.name).sort()).toEqual(["tool_a", "tool_b"]);
    // 覆盖：再次注册替换为 tool_c
    registry.register("s1", [{ name: "tool_c", description: "C", input_schema: { type: "object" } }]);
    expect(registry.get("s1").map((t) => t.name)).toEqual(["tool_c"]);
  });

  it("per-session 隔离", () => {
    const registry = new HostToolRegistry();
    registry.register("s1", [{ name: "tool_a", description: "A", input_schema: {} }]);
    registry.register("s2", [{ name: "tool_b", description: "B", input_schema: {} }]);
    expect(registry.get("s1").map((t) => t.name)).toEqual(["tool_a"]);
    expect(registry.get("s2").map((t) => t.name)).toEqual(["tool_b"]);
  });

  it("跳过无 name 的声明", () => {
    const registry = new HostToolRegistry();
    registry.register("s1", [
      { name: "ok", description: "ok", input_schema: {} },
      { name: "", description: "empty", input_schema: {} },
    ] as DelegatedToolDeclarationWire[]);
    expect(registry.get("s1").map((t) => t.name)).toEqual(["ok"]);
  });

  it("clear 清空指定 session", () => {
    const registry = new HostToolRegistry();
    registry.register("s1", [{ name: "tool_a", description: "A", input_schema: {} }]);
    registry.clear("s1");
    expect(registry.get("s1")).toEqual([]);
  });
});
