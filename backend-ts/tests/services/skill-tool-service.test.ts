import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { AgentConfigService } from "../../src/services/agent/config/index.js";
import { ArtifactService } from "../../src/services/artifacts/artifact-service.js";
import { BackgroundTaskService } from "../../src/services/runtime/background-task-service.js";
import { SessionNotificationQueue } from "../../src/services/runtime/session-notification-queue.js";
import { SkillToolService } from "../../src/tools/SkillTools/SkillExecution.js";
import { toolContext } from "../helpers/tool-context.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("SkillToolService", () => {
  it("loads skills from builtin, global, and workspace roots by source priority", () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const globalRoot = path.join(root, "global");
    const workspaceRoot = path.join(root, "workspace");
    writeSkill(path.join(builtinRoot, "shared-skill"), "shared-skill", "builtin copy", "# Builtin\n");
    writeSkill(path.join(globalRoot, "global-only"), "global-only", "global only", "# Global\n");
    writeSkill(path.join(workspaceRoot, ".ragsystem", "skills", "shared-skill"), "shared-skill", "workspace copy", "# Workspace\n");

    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: globalRoot,
    });

    expect(service.listAvailableSkills(workspaceRoot)).toEqual([
      expect.objectContaining({
        name: "global-only",
        source_type: "user_global",
        source_label: "全局",
        is_auto_inject_candidate: false,
      }),
      expect.objectContaining({
        name: "shared-skill",
        description: "workspace copy",
        source_type: "workspace",
        source_label: "工作区",
      }),
    ]);
  });

  it("enforces Skill visibility by source and Agent config", () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const globalRoot = path.join(root, "global");
    const workspaceRoot = path.join(root, "workspace");
    writeSkill(path.join(builtinRoot, "builtin-skill"), "builtin-skill", "builtin only", "# Builtin\n");
    writeSkill(path.join(globalRoot, "global-skill"), "global-skill", "global only", "# Global\n");
    writeSkill(path.join(workspaceRoot, ".ragsystem", "skills", "workspace-skill"), "workspace-skill", "workspace only", "# Workspace\n");
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: globalRoot,
    });

    expect(service.hasVisibleSkills(skillAgent([], true, workspaceRoot), workspaceRoot)).toBe(true);
    expect(service.activateSkill({ skillName: "workspace-skill" }, toolContext({ workspaceRoot }), skillAgent([], true, workspaceRoot))).toMatchObject({
      success: true,
    });
    expect(service.activateSkill({ skillName: "global-skill" }, toolContext({ workspaceRoot }), skillAgent([], true, workspaceRoot))).toMatchObject({
      success: false,
      summary: expect.stringContaining("无权使用"),
    });
    expect(service.hasVisibleSkills(skillAgent([], true), null)).toBe(false);
    expect(service.hasVisibleSkills(skillAgent(["global-skill"], false), null)).toBe(true);
    expect(service.activateSkill({ skillName: "global-skill" }, toolContext(), skillAgent(["global-skill"], false))).toMatchObject({
      success: true,
    });
    expect(service.activateSkill({ skillName: "builtin-skill" }, toolContext(), skillAgent(["builtin-skill"], false))).toMatchObject({
      success: true,
    });
  });

  it("activates skills, loads resources, and executes structured JSON scripts", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "demo-skill");
    writeSkill(skillDir, "demo-skill", "demo description", "# Demo\nUse resource.\n");
    fs.writeFileSync(path.join(skillDir, "reference.md"), "extra docs", "utf8");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "scripts", "report.py"),
      "import json\nprint(json.dumps({'success': True, 'summary': 'ok', 'data': {'items': [1, 2]}}))\n",
      "utf8",
    );
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: builtinRoot, userGlobalSkillsRoot: path.join(root, "global") });
    const context = toolContext({ sessionId: "s1" });
    const agent = skillAgent(["demo-skill"]);

    expect(service.activateSkill({ skillName: "demo-skill" }, context, agent)).toMatchObject({
      success: true,
      outputType: "markdown",
      content: {
        main_content: "# Demo\nUse resource.",
      },
    });
    expect(service.loadSkillResource({ skillName: "demo-skill", resourceFile: "reference.md" }, context, agent)).toMatchObject({
      success: true,
      content: {
        file_name: "reference.md",
        content: "extra docs",
      },
    });

    await expect(
      service.executeSkillScript({ skillName: "demo-skill", scriptName: "report.py", arguments: [] }, context, agent),
    ).resolves.toMatchObject({
      success: true,
      outputType: "json",
      content: {
        items: [1, 2],
      },
      metadata: {
        summary: "ok",
        script_name: "report.py",
        skill: "demo-skill",
      },
    });
  });

  it("applies team protocol emitted by skill scripts to AgentConfigService", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "team-generation");
    writeSkill(skillDir, "team-generation", "team generator", "# Team\n");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "scripts", "generate_team.py"),
      [
        "import json",
        "print(json.dumps({",
        "  'success': True,",
        "  'data': {'reason': 'for task'},",
        "  'team': {",
        "    'action': 'create_or_replace',",
        "    'team_name': 'generated-team',",
        "    'source_team': 'default',",
        "    'agents': {",
        "      'planner_agent': {",
        "        'display_name': 'Planner',",
        "        'description': 'Plans work',",
        "        'enabled': True,",
        "        'default_entry': True,",
        "        'custom_params': {'behavior': {'system_prompt': 'Plan.'}}",
        "      }",
        "    }",
        "  }",
        "}))",
      ].join("\n"),
      "utf8",
    );
    const agentConfig = new AgentConfigService({ dataRoot: root });
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: path.join(root, "global"),
      agentConfig,
    });

    await expect(
      service.executeSkillScript(
        { skillName: "team-generation", scriptName: "generate_team.py", arguments: [] },
        toolContext(),
        skillAgent(["team-generation"]),
      ),
    ).resolves.toMatchObject({
      success: true,
      content: {
        reason: "for task",
        team_name: "generated-team",
        agent_count: 1,
        agents: ["planner_agent"],
        applied: true,
      },
      metadata: {
        team_name: "generated-team",
        team_applied: true,
      },
    });

    expect(agentConfig.listTeams().teams.map((team) => team.team_name)).toContain("generated-team");
    const team = readYaml(path.join(root, "config", "agents", "teams", "generated-team.yaml"));
    expect(team).toMatchObject({
      agents: {
        planner_agent: {
          agent_name: "planner_agent",
          display_name: "Planner",
          default_entry: true,
        },
      },
    });
  });

  it("persists visualization artifacts emitted by skill scripts and supports revise", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "visualization");
    writeSkill(skillDir, "visualization", "visualization tools", "# Viz\n");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "scripts", "create_chart.py"),
      [
        "import json",
        "print(json.dumps({",
        "  'success': True,",
        "  'data': {'title': 'Rainfall'},",
        "  'artifact': {",
        "    'viz_type': 'chart',",
        "    'sub_type': 'bar',",
        "    'title': 'Rainfall',",
        "    'config': {'series': [{'type': 'bar', 'data': [1, 2]}]}",
        "  }",
        "}))",
      ].join("\n"),
      "utf8",
    );
    const artifacts = new ArtifactService({ dataRoot: root });
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: path.join(root, "global"),
      artifacts,
    });

    const created = await service.executeSkillScript(
      { skillName: "visualization", scriptName: "create_chart.py", arguments: [] },
      toolContext({ sessionId: "viz-session" }),
      skillAgent(["visualization"]),
    );

    expect(created).toMatchObject({
      success: true,
      outputType: "chart",
      content: {
        title: "Rainfall",
        viz_type: "chart",
      },
      metadata: {
        artifact_persisted: true,
      },
    });
    const artifactId = readArtifactId(created.content);
    expect(created.llmHint).toBe(`在 <final_answer> 中插入 [viz:${artifactId}] 来展示此可视化`);
    expect(artifacts.getVisualization(artifactId)).toMatchObject({
      artifact_id: artifactId,
      viz_type: "chart",
      sub_type: "bar",
      title: "Rainfall",
      version: 1,
      config: {
        series: [{ type: "bar", data: [1, 2] }],
      },
    });

    fs.writeFileSync(
      path.join(skillDir, "scripts", "revise_chart.py"),
      [
        "import json, sys",
        "artifact_id = sys.argv[1]",
        "print(json.dumps({",
        "  'success': True,",
        "  'data': {'revised': True},",
        "  'artifact': {",
        "    'action': 'revise',",
        "    'artifact_id': artifact_id,",
        "    'config': {'series': [{'type': 'bar', 'data': [3, 4]}]}",
        "  }",
        "}))",
      ].join("\n"),
      "utf8",
    );

    await expect(
      service.executeSkillScript(
        { skillName: "visualization", scriptName: "revise_chart.py", arguments: [artifactId] },
        toolContext({ sessionId: "viz-session" }),
        skillAgent(["visualization"]),
      ),
    ).resolves.toMatchObject({
      success: true,
      outputType: "chart",
      content: {
        artifact_id: artifactId,
        viz_type: "chart",
      },
      metadata: {
        artifact_id: artifactId,
        artifact_persisted: true,
      },
    });
    expect(artifacts.getVisualization(artifactId)).toMatchObject({
      version: 2,
      config: {
        series: [{ type: "bar", data: [3, 4] }],
      },
    });
  });

  it("runs skill scripts in background and writes structured task output", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "demo-skill");
    writeSkill(skillDir, "demo-skill", "demo description", "# Demo\n");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "scripts", "report.py"),
      "import json\nprint(json.dumps({'success': True, 'data': {'river': [{'site_name': '柳州水文站'}]}}))\n",
      "utf8",
    );
    const backgroundTasks = new BackgroundTaskService();
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: path.join(root, "global"),
      backgroundTasks,
    });

    const agent = skillAgent(["demo-skill"]);
    agent.tasks = { workflow: false, background: true };
    const started = await service.executeSkillScript(
      { skillName: "demo-skill", scriptName: "report.py", arguments: [], runInBackground: true },
      toolContext({ sessionId: "bg-session", runId: "run-1", taskId: "task-1" }),
      agent,
    );

    expect(started).toMatchObject({
      success: true,
      content: {
        background_started: true,
        background_task_id: expect.any(String),
      },
      metadata: {
        background_kind: "callable",
        cancel_supported: false,
        background_output_path: expect.stringContaining("./data/sessions/bg-session/transient/bg_"),
      },
    });

    const taskId = readBackgroundTaskId(started.content);
    await waitFor(() => backgroundTasks.getTask(taskId)?.status === "completed");
    const task = backgroundTasks.getTask(taskId);
    expect(task).toMatchObject({
      status: "completed",
      result_type: "tool_execution_result",
      kind: "callable",
      cancel_supported: false,
    });
    const output = JSON.parse(backgroundTasks.readOutput(taskId) ?? "{}") as Record<string, unknown>;
    expect(output).toMatchObject({
      success: true,
      result_type: "tool_execution_result",
      result: {
        toolName: "execute_skill_script",
        outputType: "json",
        content: {
          river: [{ site_name: "柳州水文站" }],
        },
      },
    });
  });

  it("rejects background skill scripts when tasks.background is disabled", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "demo-skill");
    writeSkill(skillDir, "demo-skill", "demo description", "# Demo\n");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "scripts", "report.py"), "print('ok')\n", "utf8");
    const notificationQueue = new SessionNotificationQueue();
    const backgroundTasks = new BackgroundTaskService({ notificationQueue });
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: path.join(root, "global"),
      backgroundTasks,
    });

    const result = await service.executeSkillScript(
      { skillName: "demo-skill", scriptName: "report.py", arguments: [], runInBackground: true },
      toolContext({ sessionId: "bg-session" }),
      skillAgent(["demo-skill"]),
    );

    expect(result).toMatchObject({
      success: false,
      toolName: "execute_skill_script",
      content: expect.stringContaining("未启用 tasks.background"),
      metadata: {
        background_started: false,
      },
    });
    expect(notificationQueue.drain("bg-session", new Set())).toEqual([]);
  });

  it("does not create a venv in shared isolation mode even with requirements.txt", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "shared-skill");
    writeSkill(skillDir, "shared-skill", "shared mode", "# Shared\n");
    fs.writeFileSync(path.join(skillDir, "requirements.txt"), "", "utf8");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "scripts", "where.py"),
      "import json, sys\nprint(json.dumps({'success': True, 'data': {'executable': sys.executable}}))\n",
      "utf8",
    );
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: path.join(root, "global"),
      skillIsolationMode: "shared",
    });

    const result = await service.executeSkillScript(
      { skillName: "shared-skill", scriptName: "where.py", arguments: [] },
      toolContext(),
      skillAgent(["shared-skill"]),
    );

    expect(result).toMatchObject({ success: true });
    expect(fs.existsSync(path.join(skillDir, ".venv"))).toBe(false);
  });

  it("provisions a per-skill venv and runs scripts with its interpreter", async () => {
    const root = makeTempRoot();
    const builtinRoot = path.join(root, "builtin");
    const skillDir = path.join(builtinRoot, "venv-skill");
    writeSkill(skillDir, "venv-skill", "venv mode", "# Venv\n");
    fs.writeFileSync(path.join(skillDir, "requirements.txt"), "# no external deps\n", "utf8");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "scripts", "where.py"),
      "import json, sys\nprint(json.dumps({'success': True, 'data': {'executable': sys.executable}}))\n",
      "utf8",
    );
    const service = new SkillToolService({
      dataRoot: root,
      builtinSkillsRoot: builtinRoot,
      userGlobalSkillsRoot: path.join(root, "global"),
      skillIsolationMode: "venv",
    });

    const result = await service.executeSkillScript(
      { skillName: "venv-skill", scriptName: "where.py", arguments: [] },
      toolContext(),
      skillAgent(["venv-skill"]),
    );

    expect(result).toMatchObject({ success: true });
    const executable = String((result.content as Record<string, unknown>).executable ?? "");
    expect(executable).toContain(".venv");
    expect(fs.existsSync(path.join(skillDir, ".venv"))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, ".venv", ".installed"))).toBe(true);
  }, 120_000);
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-skills-"));
  tempRoots.push(root);
  return root;
}

function writeSkill(skillDir: string, name: string, description: string, body: string): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    "utf8",
  );
}

function readYaml(filePath: string): Record<string, unknown> {
  const parsed = YAML.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} did not contain an object`);
  }
  return parsed as Record<string, unknown>;
}

function skillAgent(enabledSkills: string[], defaultEntry = false, workspaceRoot?: string): AgentConfig {
  return {
    agent_name: "skill_agent",
    enabled: true,
    default_entry: defaultEntry,
    tools: { enabled_tools: [] },
    skills: { enabled_skills: enabledSkills },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["team", "session"],
      write_scopes: ["session"],
      archive_scopes: ["session"],
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: workspaceRoot ? { workspace_root: workspaceRoot } : {},
  };
}

function readArtifactId(content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("content missing artifact_id");
  }
  const artifactId = (content as Record<string, unknown>).artifact_id;
  if (typeof artifactId !== "string") {
    throw new Error("artifact_id missing");
  }
  return artifactId;
}

function readBackgroundTaskId(content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("content missing background_task_id");
  }
  const taskId = (content as Record<string, unknown>).background_task_id;
  if (typeof taskId !== "string") {
    throw new Error("background_task_id missing");
  }
  return taskId;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before timeout");
}
