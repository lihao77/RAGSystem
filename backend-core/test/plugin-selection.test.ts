import { describe, expect, it, vi } from "vitest";

import { selectBackendPlugins } from "../src/plugins/plugin-selection.js";

describe("selectBackendPlugins", () => {
  it("loads all installed plugins by default and supports explicit ordering", () => {
    const createA = vi.fn(() => plugin("a"));
    const createB = vi.fn(() => plugin("b"));
    const catalog = { a: createA, b: createB };

    expect(selectBackendPlugins(catalog, undefined).map((item) => item.manifest.id)).toEqual(["a", "b"]);
    expect(selectBackendPlugins(catalog, "b,a").map((item) => item.manifest.id)).toEqual(["b", "a"]);
    expect(createA).toHaveBeenCalledTimes(2);
    expect(createB).toHaveBeenCalledTimes(2);
  });

  it("can disable all plugins without constructing them", () => {
    const create = vi.fn(() => plugin("a"));
    expect(selectBackendPlugins({ a: create }, "none")).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects unknown and duplicate plugin names", () => {
    const catalog = { a: () => plugin("a") };
    expect(() => selectBackendPlugins(catalog, "missing")).toThrow("Backend plugins are not installed: missing");
    expect(() => selectBackendPlugins(catalog, "a,a")).toThrow("BACKEND_PLUGINS contains duplicate names");
  });
});

function plugin(id: string) {
  return { manifest: { id, version: "1.0.0" }, register() {} };
}
