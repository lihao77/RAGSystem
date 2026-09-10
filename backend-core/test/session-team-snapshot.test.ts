import { describe, expect, it } from "vitest";

import { AgentConfigSchema, TeamSelectionError } from "../src/contracts/agent/agent-config.js";
import type { AgentConfigTeam, IAgentConfigTeamStore } from "../src/contracts/agent/team-store.js";
import { registerRetiredToolNames } from "../src/contracts/agent/tool-name-aliases.js";
import {
  computeSessionTeamRevision,
  hydrateSessionMetadata,
  hydrateSessionTeamSnapshot,
  normalizeSessionMetadata,
  normalizeSessionTeamSnapshot,
  requireSessionTeamSnapshot,
  SessionTeamSnapshotSchema,
  type SessionInfo,
} from "../src/contracts/session/session.js";
import { AgentConfigService } from "../src/services/agent/config/index.js";

// 退役名是插件知识：单测环境无插件注册，按执行工具插件描述符的声明方式注册。
registerRetiredToolNames("execute_shell", ["execute_bash"]);

class MemoryTeamStore implements IAgentConfigTeamStore {
  async loadTeams() {
    // 内核不再兜底出厂 team：夹具预置最小 default team（产品层 ensure 的等价物）。
    return {
      activeTeam: "default",
      teams: new Map<string, AgentConfigTeam>([
        ["default", new Map(Object.entries({
          orchestrator_agent: {
            agent_name: "orchestrator_agent",
            display_name: "Orchestrator Agent",
            description: "入口编排 Agent。",
            enabled: true,
            default_entry: true,
            llm_tiers: null,
            tools: { enabled_tools: [] },
            goals: { enabled: false },
            tasks: { background: false },
            delegation: { enabled_agents: [], parallel_children: false },
            custom_params: {},
          },
        }))],
      ]),
    };
  }
  async saveAll(_activeTeam: string, _teams: Map<string, AgentConfigTeam>) {}
  async saveIndex(_activeTeam: string, _teams: Map<string, AgentConfigTeam>) {}
  async removeTeam(_teamName: string) {}
  async renameTeam(_teamName: string, _newTeamName: string) {}
  async getTeamLocation() { return null; }
}

describe("Session Team snapshots", () => {
  it("keeps an existing snapshot immutable when its source Team changes", async () => {
    const service = new AgentConfigService(new MemoryTeamStore());
    await service.initialize();
    const first = service.createTeamSnapshot();

    await service.patchConfig("orchestrator_agent", { display_name: "Changed Orchestrator" });
    const second = service.createTeamSnapshot();

    expect(first.team_name).toBe("default");
    expect(first.entry_agent_name).toBe("orchestrator_agent");
    expect(first.team_revision).not.toBe(second.team_revision);
    expect(first.agents.orchestrator_agent?.display_name).not.toBe("Changed Orchestrator");
    expect(second.agents.orchestrator_agent?.display_name).toBe("Changed Orchestrator");
  });

  it("rejects legacy Team routing hidden in free-form Session metadata", () => {
    expect(() => normalizeSessionMetadata({ team: "default" })).toThrow(/保留字段/);
    expect(() => normalizeSessionMetadata({ entry_agent: "orchestrator_agent" })).toThrow(/保留字段/);
  });

  it("hydrates reserved keys out of legacy Session metadata on read paths", () => {
    // 历史形状：保留字规则收紧前，自由 metadata 曾合法承载 team/entry_agent
    // （今天的语义由一等字段与 team_snapshot 承载）。读取汇点必须剔除它们，
    // 否则存量行的任何 metadata 合并更新都会在保留字校验处崩溃（飞书机器人
    // 对旧会话的消息曾因此二段崩溃）。其余键原样保留；下次回写落盘干净形状。
    const legacy = {
      chatId: "oc_0d2d",
      team: "2",
      entry_agent: "orchestrator_agent",
      feishu: { sender_open_id: "ou_x" },
      workspace_root: "/tmp",
    };
    expect(hydrateSessionMetadata(legacy)).toEqual({
      chatId: "oc_0d2d",
      feishu: { sender_open_id: "ou_x" },
    });
    // 非对象/空形状容忍；干净 metadata 幂等透传。
    expect(hydrateSessionMetadata(null)).toEqual({});
    expect(hydrateSessionMetadata("junk")).toEqual({});
    expect(hydrateSessionMetadata({ chatId: "x" })).toEqual({ chatId: "x" });
  });

  it("rejects a revision that does not cover the complete Agent snapshot", async () => {
    const service = new AgentConfigService(new MemoryTeamStore());
    await service.initialize();
    const snapshot = service.createTeamSnapshot();
    expect(() => SessionTeamSnapshotSchema.parse({
      ...snapshot,
      team_revision: "0".repeat(64),
    })).toThrow(/revision does not match/);
  });

  it("classifies invalid Team selections as client input errors", async () => {
    const service = new AgentConfigService(new MemoryTeamStore());
    await service.initialize();
    expect(() => service.createTeamSnapshot({ teamName: "missing" })).toThrow(TeamSelectionError);
    expect(() => service.createTeamSnapshot({ entryAgentName: "missing" })).toThrow(TeamSelectionError);
  });

  it("renames retired execute_bash in persisted snapshots and reanchors the revision", () => {
    // 历史形状：改名前落库的快照，agents.enabled_tools 携带 execute_bash，
    // team_revision 是对旧形状计算的内容锚点。
    const rawAgents = {
      orchestrator_agent: {
        agent_name: "orchestrator_agent",
        tools: { enabled_tools: ["read_file", "execute_bash"] },
      },
    };
    const persisted = {
      team_name: "default",
      team_revision: computeSessionTeamRevision(rawAgents),
      entry_agent_name: "orchestrator_agent",
      agents: rawAgents,
    };

    const normalized = normalizeSessionTeamSnapshot(persisted);
    expect(normalized.agents.orchestrator_agent?.tools?.enabled_tools).toEqual(["read_file", "execute_shell"]);
    // 重锚定：revision 改写为现名形状的哈希，恒等于 parse 结果内容的内容哈希，
    // 下游（run-engine 身份比对、SaaS createSession 冲突检测）比较原文即一致。
    expect(normalized.team_revision).toBe(computeSessionTeamRevision(normalized.agents));
    expect(normalized.team_revision).not.toBe(persisted.team_revision);
    // 幂等：归一后的快照再 parse 不变。
    const current = normalizeSessionTeamSnapshot(normalized);
    expect(current).toEqual(normalized);
  });

  it("keeps duplicate tool names when renaming so the stored revision anchor still matches", () => {
    // 历史形状（review P1-1 反例）：存量 enabled_tools 含重复项且带退役名。落库 revision
    // 按未去重原形状计算——逐项改名（不全局去重）才能让锚点命中并重锚定，快照不至于不可读。
    const rawAgents = {
      orchestrator_agent: {
        agent_name: "orchestrator_agent",
        tools: { enabled_tools: ["read_file", "read_file", "execute_bash"] },
      },
    };
    const persisted = {
      team_name: "default",
      team_revision: computeSessionTeamRevision(rawAgents),
      entry_agent_name: "orchestrator_agent",
      agents: rawAgents,
    };

    const normalized = normalizeSessionTeamSnapshot(persisted);
    expect(normalized.agents.orchestrator_agent?.tools?.enabled_tools)
      .toEqual(["read_file", "read_file", "execute_shell"]);
    expect(normalized.team_revision).toBe(computeSessionTeamRevision(normalized.agents));
  });

  it("parses mixed retired/current names by renaming item-wise (hand-edited degenerate shape)", () => {
    // 新旧名并存只会来自对库内快照的手工编辑；逐项改名语义 = execute_bash→execute_shell、
    // 其余原样，revision 命中退役名形状哈希即重锚定。行为钉死，防止后人无意改断。
    const rawAgents = {
      orchestrator_agent: {
        agent_name: "orchestrator_agent",
        tools: { enabled_tools: ["execute_bash", "execute_shell", "read_file"] },
      },
    };
    const persisted = {
      team_name: "default",
      team_revision: computeSessionTeamRevision(rawAgents),
      entry_agent_name: "orchestrator_agent",
      agents: rawAgents,
    };

    const normalized = normalizeSessionTeamSnapshot(persisted);
    expect(normalized.agents.orchestrator_agent?.tools?.enabled_tools)
      .toEqual(["execute_shell", "execute_shell", "read_file"]);
    expect(normalized.team_revision).toBe(computeSessionTeamRevision(normalized.agents));
  });

  it("hydrates NULL as the legacy un-anchored shape on read paths (2026-08 快照特性前的存量行)", () => {
    // 历史形状：team_snapshot 列为 NULL 的存量会话行。读取汇点（local mappers /
    // SaaS conversation-repository）必须透传 null 而不是抛 ZodError——该形状曾让
    // 飞书机器人对旧会话的所有新消息在 rowToSession 处静默崩溃。
    expect(hydrateSessionTeamSnapshot(null)).toBeNull();
    expect(hydrateSessionTeamSnapshot(undefined)).toBeNull();
    // 非空形状仍走严格校验，与 normalizeSessionTeamSnapshot 完全同构。
    const rawAgents = { orchestrator_agent: AgentConfigSchema.parse({ agent_name: "orchestrator_agent" }) };
    const persisted = {
      team_name: "default",
      team_revision: computeSessionTeamRevision(rawAgents),
      entry_agent_name: "orchestrator_agent",
      agents: rawAgents,
    };
    expect(hydrateSessionTeamSnapshot(persisted)).toEqual(normalizeSessionTeamSnapshot(persisted));
    // 写入端语义不变：normalize 对 NULL 依旧严格拒绝（新建/更新路径必须携带快照）。
    expect(() => normalizeSessionTeamSnapshot(null)).toThrow();
  });

  it("requires an anchored snapshot on execution paths and names the session", () => {
    const legacy: SessionInfo = {
      session_id: "legacy-session",
      team_snapshot: null,
      tenant_id: "tnt_test" as never,
      owner_user_id: null,
      visibility: "private",
      origin_type: "direct",
      origin_id: null,
      origin_channel: "web",
      workspace_id: null,
      permission_mode: null,
      metadata: {},
      created_at: "2026-07-26T00:00:00.000Z",
      updated_at: "2026-07-26T00:00:00.000Z",
    };
    expect(() => requireSessionTeamSnapshot(legacy)).toThrow(/legacy-session/);

    const rawAgents = { orchestrator_agent: AgentConfigSchema.parse({ agent_name: "orchestrator_agent" }) };
    const anchored: SessionInfo = {
      ...legacy,
      team_snapshot: {
        team_name: "default",
        team_revision: computeSessionTeamRevision(rawAgents),
        entry_agent_name: "orchestrator_agent",
        agents: rawAgents,
      },
    };
    expect(requireSessionTeamSnapshot(anchored)).toBe(anchored.team_snapshot);
  });
});
