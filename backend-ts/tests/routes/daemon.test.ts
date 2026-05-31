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
      runtime: "not_migrated",
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
        runtime: "not_migrated",
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

  it("keeps real daemon runtime effects as explicit not-migrated boundaries", async () => {
    app = await buildTestApp();

    const start = await app.inject({
      method: "POST",
      url: "/api/daemon/start",
      payload: {},
    });
    expect(start.statusCode).toBe(501);
    expect(start.json()).toMatchObject({
      success: false,
      code: "not_migrated",
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
    expect(send.statusCode).toBe(501);

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
    expect(trigger.statusCode).toBe(501);
    expect(trigger.json()).toMatchObject({
      code: "not_migrated",
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
