import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;
let root: string | null = null;
const previousFrontendDist = process.env.FRONTEND_DIST;

afterEach(async () => {
  if (app) await app.close();
  app = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
  if (previousFrontendDist === undefined) delete process.env.FRONTEND_DIST;
  else process.env.FRONTEND_DIST = previousFrontendDist;
});

describe("frontend fallback", () => {
  it("serves built frontend assets with browser-compatible MIME types", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-frontend-"));
    fs.mkdirSync(path.join(root, "assets"));
    fs.writeFileSync(path.join(root, "index.html"), '<div id="app"></div>', "utf8");
    fs.writeFileSync(path.join(root, "assets", "app.js"), "export const ready = true;", "utf8");
    fs.writeFileSync(path.join(root, "assets", "app.css"), "body { color: black; }", "utf8");
    fs.writeFileSync(path.join(root, "assets", "app.woff2"), Buffer.from([0, 1, 2]));
    process.env.FRONTEND_DIST = root;
    app = await buildTestApp();

    const javascript = await app.inject({ method: "GET", url: "/assets/app.js" });
    const stylesheet = await app.inject({ method: "GET", url: "/assets/app.css" });
    const font = await app.inject({ method: "GET", url: "/assets/app.woff2" });
    expect(javascript.headers["content-type"]).toContain("application/javascript");
    expect(stylesheet.headers["content-type"]).toContain("text/css");
    expect(font.headers["content-type"]).toContain("font/woff2");
  });
});
