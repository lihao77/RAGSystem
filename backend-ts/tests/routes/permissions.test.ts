import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("permission policy routes", () => {
  it("returns the default Python-compatible permission policy", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/permissions/policy",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: "standard",
      auto_accept_patterns: [],
      audit_all_checks: false,
      approval_timeout: 300,
      skip_all_approvals: false,
    });
  });

  it("updates mode and whole policy", async () => {
    app = await buildTestApp();

    const mode = await app.inject({
      method: "PUT",
      url: "/api/permissions/mode",
      payload: { mode: "relaxed" },
    });
    expect(mode.statusCode).toBe(200);
    expect(mode.json()).toEqual({ mode: "relaxed" });

    const policy = await app.inject({
      method: "PUT",
      url: "/api/permissions/policy",
      payload: {
        mode: "strict",
        auto_accept_patterns: [
          {
            pattern_type: "tool_name",
            pattern_value: "read_*",
            description: "readonly",
          },
        ],
        audit_all_checks: true,
        approval_timeout: 120,
        skip_all_approvals: true,
      },
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toEqual({
      mode: "strict",
      auto_accept_patterns: [
        {
          pattern_type: "tool_name",
          pattern_value: "read_*",
          description: "readonly",
        },
      ],
      audit_all_checks: true,
      approval_timeout: 120,
      skip_all_approvals: true,
    });
  });

  it("adds, removes, and clears auto-accept patterns", async () => {
    app = await buildTestApp();

    const added = await app.inject({
      method: "POST",
      url: "/api/permissions/auto-accept",
      payload: {
        pattern_type: "risk_level",
        pattern_value: "low",
        description: "low risk",
      },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({
      auto_accept_patterns: [
        {
          pattern_type: "risk_level",
          pattern_value: "low",
          description: "low risk",
        },
      ],
    });

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/permissions/auto-accept",
      payload: {
        pattern_type: "risk_level",
        pattern_value: "low",
      },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      removed: true,
      auto_accept_patterns: [],
    });

    await app.inject({
      method: "POST",
      url: "/api/permissions/auto-accept",
      payload: {
        pattern_type: "tool_name",
        pattern_value: "read_file",
      },
    });
    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/permissions/auto-accept/all",
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      auto_accept_patterns: [],
    });
  });
});
