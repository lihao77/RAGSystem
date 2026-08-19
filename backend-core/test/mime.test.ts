import { describe, expect, it } from "vitest";

import { inferMimeType } from "../src/utils/mime.js";

describe("inferMimeType", () => {
  it("maps known extensions", () => {
    expect(inferMimeType("report.pdf")).toBe("application/pdf");
    expect(inferMimeType("data/site.png")).toBe("image/png");
    expect(inferMimeType("data/SITE.PNG")).toBe("image/png");
    expect(inferMimeType("export.tsv")).toBe("text/tab-separated-values");
    expect(inferMimeType("clip.webm")).toBe("video/webm");
    expect(inferMimeType("scene.geojson")).toBe("application/geo+json");
  });

  it("handles Windows absolute paths with backslashes", () => {
    expect(inferMimeType("D:\\sessions\\abc123\\report.pdf")).toBe("application/pdf");
    expect(inferMimeType("D:\\sessions\\abc123\\summary.md")).toBe("text/plain");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(inferMimeType("archive.tar.gz")).toBe("application/octet-stream");
    expect(inferMimeType("D:\\data\\.project\\sessions\\noext")).toBe("application/octet-stream");
    expect(inferMimeType("README")).toBe("application/octet-stream");
  });
});
