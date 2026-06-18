import { describe, expect, it } from "vitest";

import {
  matchesFileFilters,
  normalizeExtensions,
  normalizeFilterList,
  sanitizeFilename,
} from "../../src/utils/file-filter.js";

describe("sanitizeFilename", () => {
  it("保留 ASCII 字母数字/下划线/连字符/点", () => {
    expect(sanitizeFilename("report_2026.pdf")).toBe("report_2026.pdf");
    expect(sanitizeFilename("a-b-c.txt")).toBe("a-b-c.txt");
  });

  it("非 [\\w\\-.] 字符替换为下划线并裁掉首尾下划线", () => {
    expect(sanitizeFilename("  hello world.pdf  ")).toBe("hello_world.pdf");
    expect(sanitizeFilename("(draft)v2.md")).toBe("draft_v2.md");
  });

  it("纯非法字符/空 → upload.bin 兜底", () => {
    expect(sanitizeFilename("")).toBe("upload.bin");
    expect(sanitizeFilename("中文文件名")).toBe("upload.bin");
    expect(sanitizeFilename("   ")).toBe("upload.bin");
  });
});

describe("normalizeExtensions", () => {
  it("无点补点、有点保留,统一小写 + trim", () => {
    expect(normalizeExtensions(["PDF", ".txt", " md "])).toEqual([".pdf", ".txt", ".md"]);
  });

  it("undefined/空 → []", () => {
    expect(normalizeExtensions(undefined)).toEqual([]);
    expect(normalizeExtensions([])).toEqual([]);
  });
});

describe("normalizeFilterList", () => {
  it("trim + 小写 + 去空(mime 通用)", () => {
    expect(normalizeFilterList([" text/PLAIN ", "application/pdf", ""])).toEqual([
      "text/plain",
      "application/pdf",
    ]);
  });
});

describe("matchesFileFilters", () => {
  it("无过滤参数 → 全部命中", () => {
    expect(matchesFileFilters("any.pdf", "application/pdf")).toBe(true);
  });

  it("扩展名匹配:传 pdf 或 .pdf 等价", () => {
    expect(matchesFileFilters("report.pdf", "application/pdf", ["pdf"])).toBe(true);
    expect(matchesFileFilters("report.PDF", "application/pdf", [".pdf"])).toBe(true);
  });

  it("扩展名补点:无扩展名文件名不被 pdf 误匹配", () => {
    // 回归点:旧 endsWith("pdf") 会把 "reportpdf" 误判命中
    expect(matchesFileFilters("reportpdf", "application/pdf", ["pdf"])).toBe(false);
    expect(matchesFileFilters("myreport", "application/pdf", ["pdf"])).toBe(false);
  });

  it("mime 精确(小写)匹配", () => {
    expect(matchesFileFilters("a.txt", "text/plain", undefined, ["text/plain"])).toBe(true);
    expect(matchesFileFilters("a.txt", "text/plain", undefined, ["TEXT/PLAIN"])).toBe(true);
    expect(matchesFileFilters("a.txt", "text/plain", undefined, ["application/pdf"])).toBe(false);
  });

  it("ext 与 mime 同时给 → OR 语义", () => {
    // ext 不中、mime 中 → 命中
    expect(matchesFileFilters("a.csv", "application/pdf", ["txt"], ["application/pdf"])).toBe(true);
    // 两者都不中 → 不命中
    expect(matchesFileFilters("a.csv", "text/plain", ["txt"], ["application/pdf"])).toBe(false);
  });
});
