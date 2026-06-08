import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildTestApp } from "../helpers/app.js";
import { createRuntimeContainer } from "../../src/services/runtime/runtime-container.js";

let app: FastifyInstance | null = null;
const tempRoots: string[] = [];

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("daemon compatibility routes", () => {
  it("serves an idle daemon status and default config", async () => {
    app = await buildTestApp();

    const status = await app.inject({
      method: "GET",
      url: "/api/daemon/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: false,
      running: false,
      runtime: "local",
      adapter_count: 0,
      daemon_sessions: 0,
      agents_count: 0,
      cron_task_count: 0,
    });

    const config = await app.inject({
      method: "GET",
      url: "/api/daemon/config",
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({
      enabled: false,
      agents: [],
      default_session_ttl: 86400,
    });
  });

  it("normalizes Python-style empty YAML cron_tasks while loading daemon config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-daemon-"));
    tempRoots.push(root);
    const configPath = path.join(root, "daemon.yaml");
    fs.writeFileSync(
      configPath,
      [
        "enabled: false",
        "default_session_ttl: 86400",
        "agents:",
        "  - team_name: default",
        "    entry_agent:",
        "    enabled: true",
        "    permissions:",
        "      mode: standard",
        "    platforms:",
        "      feishu:",
        "        enabled: false",
        "        extra:",
        "    cron_tasks:",
        "      # empty list in commented Python example parses as null",
        "",
      ].join("\n"),
      "utf8",
    );

    const container = createRuntimeContainer({
      dbPath: ":memory:",
      checkpointDbPath: ":memory:",
      dataRoot: root,
      modelAdapterProvidersConfigPath: "",
      mcpConfigPath: "",
      daemonConfigPath: configPath,
      agentConfigRoot: "",
      startOutboxDispatcher: false,
    });
    try {
      expect(container.daemon.listCronTasks()).toEqual([]);
      expect(container.daemon.getConfig()).toMatchObject({
        agents: [
          {
            team_name: "default",
            platforms: {
              feishu: {
                enabled: false,
                extra: {},
              },
            },
            cron_tasks: [],
          },
        ],
      });
    } finally {
      container.close();
    }
  });

  it("stores daemon config in memory and exposes disconnected agent state", async () => {
    app = await buildTestApp();

    const payload = {
      enabled: true,
      default_session_ttl: 3600,
      agents: [
        {
          team_name: "default",
          entry_agent: "orchestrator_agent",
          session_id: "daemon-default",
          permissions: {
            mode: "relaxed",
            auto_accept_patterns: [],
            audit_all_checks: false,
            approval_timeout: 60,
            skip_all_approvals: false,
          },
          heartbeat_interval: 45,
          enabled: true,
          platforms: {
            feishu: {
              enabled: true,
              app_id: "cli_demo",
              app_secret: "secret",
              token: "token",
              encoding_aes_key: null,
              webhook_url: null,
              session_id: null,
              extra: { receive_mode: "long_connection" },
            },
          },
          cron_tasks: [],
        },
      ],
    };

    const saved = await app.inject({
      method: "PUT",
      url: "/api/daemon/config",
      payload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({
      status: "ok",
      message: "配置已保存，启动守护系统后生效",
    });

    const config = await app.inject({
      method: "GET",
      url: "/api/daemon/config",
    });
    expect(config.json()).toMatchObject(payload);

    const agents = await app.inject({
      method: "GET",
      url: "/api/daemon/agents",
    });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toEqual([
      expect.objectContaining({
        team_name: "default",
        running: false,
        runtime: "local",
        platforms: {
          feishu: expect.objectContaining({
            enabled: true,
            status: "disconnected",
            last_heartbeat: null,
          }),
        },
      }),
    ]);

    const heartbeat = await app.inject({
      method: "GET",
      url: "/api/daemon/agents/default/heartbeat?limit=5",
    });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toEqual({
      team_name: "default",
      heartbeats: {
        feishu: [],
      },
    });
  });

  it("supports in-memory cron task create, update, history, and delete", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/daemon/cron/tasks",
      payload: {
        task_id: "cron_demo",
        name: "日报",
        cron: "0 9 * * 1-5",
        task: "生成日报",
        team_name: "default",
        push_platform: "feishu",
        push_chat_id: "chat-1",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({
      status: "ok",
      task_id: "cron_demo",
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/daemon/cron/tasks",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        task_id: "cron_demo",
        name: "日报",
        enabled: true,
        last_run: null,
        last_result: null,
      }),
    ]);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/daemon/cron/tasks/cron_demo",
      payload: {
        enabled: false,
        name: "工作日日报",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      status: "ok",
      task_id: "cron_demo",
    });

    const afterUpdate = await app.inject({
      method: "GET",
      url: "/api/daemon/cron/tasks",
    });
    expect(afterUpdate.json()[0]).toMatchObject({
      task_id: "cron_demo",
      name: "工作日日报",
      enabled: false,
    });

    const history = await app.inject({
      method: "GET",
      url: "/api/daemon/cron/tasks/cron_demo/history?limit=10",
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({
      task_id: "cron_demo",
      history: [],
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/daemon/cron/tasks/cron_demo",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ status: "ok" });
  });

  it("starts, sends, dispatches test messages, and manually triggers cron tasks", async () => {
    app = await buildTestApp();
    await app.inject({
      method: "PUT",
      url: "/api/daemon/config",
      payload: {
        enabled: true,
        default_session_ttl: 3600,
        agents: [
          {
            team_name: "default",
            entry_agent: "orchestrator_agent",
            session_id: "daemon-default",
            permissions: {},
            heartbeat_interval: 30,
            enabled: true,
            platforms: {
              feishu: {
                enabled: true,
              },
            },
            cron_tasks: [],
          },
        ],
      },
    });

    const start = await app.inject({
      method: "POST",
      url: "/api/daemon/start",
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toEqual({
      status: "ok",
      message: "守护系统已启动",
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/daemon/status",
    });
    expect(status.json()).toMatchObject({
      enabled: true,
      running: true,
      runtime: "local",
      adapter_count: 1,
    });

    const heartbeat = await app.inject({
      method: "GET",
      url: "/api/daemon/agents/default/heartbeat?limit=5",
    });
    expect(heartbeat.json().heartbeats.feishu).toEqual([
      expect.objectContaining({
        status: "connected",
      }),
    ]);

    const test = await app.inject({
      method: "POST",
      url: "/api/daemon/agents/default/test",
      payload: {
        platform: "feishu",
        chat_id: "chat-1",
        content: "hello daemon",
      },
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({
      status: "ok",
      message: "测试消息已发送",
      session_id: "daemon-default",
      result: expect.stringContaining("hello daemon"),
    });

    const send = await app.inject({
      method: "POST",
      url: "/api/daemon/send",
      payload: {
        platform: "feishu",
        chat_id: "chat-1",
        content: "hello",
      },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json()).toMatchObject({
      status: "ok",
      message_id: expect.any(String),
    });

    await app.inject({
      method: "POST",
      url: "/api/daemon/cron/tasks",
      payload: {
        task_id: "cron_demo",
        cron: "0 9 * * *",
        task: "生成日报",
        team_name: "default",
      },
    });
    const trigger = await app.inject({
      method: "POST",
      url: "/api/daemon/cron/tasks/cron_demo/trigger",
      payload: {},
    });
    expect(trigger.statusCode).toBe(200);
    expect(trigger.json()).toMatchObject({
      status: "ok",
      result: expect.stringContaining("生成日报"),
    });

    const history = await app.inject({
      method: "GET",
      url: "/api/daemon/cron/tasks/cron_demo/history?limit=10",
    });
    expect(history.json().history).toEqual([
      expect.objectContaining({
        success: true,
        result: expect.stringContaining("生成日报"),
      }),
    ]);

    const stop = await app.inject({
      method: "POST",
      url: "/api/daemon/stop",
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({
      status: "ok",
      message: "守护系统已停止",
    });
  });

  it("validates duplicate cron tasks and missing resources", async () => {
    app = await buildTestApp();

    const missingAgent = await app.inject({
      method: "GET",
      url: "/api/daemon/agents/missing/heartbeat",
    });
    expect(missingAgent.statusCode).toBe(404);
    expect(missingAgent.json()).toMatchObject({
      code: "not_found",
    });

    const payload = {
      task_id: "cron_demo",
      cron: "0 9 * * *",
      task: "生成日报",
      team_name: "default",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/daemon/cron/tasks",
          payload,
        })
      ).statusCode,
    ).toBe(200);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/daemon/cron/tasks",
      payload,
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "任务已存在: cron_demo",
    });

    const missingDelete = await app.inject({
      method: "DELETE",
      url: "/api/daemon/cron/tasks/missing",
    });
    expect(missingDelete.statusCode).toBe(404);
  });
});
