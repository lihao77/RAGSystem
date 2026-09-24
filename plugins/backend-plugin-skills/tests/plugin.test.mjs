import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SkillsAgentConfigService,
  SkillToolService,
  createSkillTools,
  createSkillsPlugin,
  resolveBuiltinSkillSources,
  normalizeScriptTimeout,
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
  MAX_SCRIPT_TIMEOUT_SECONDS,
  SKILL_SOURCE_RESOURCE,
} from "../dist/index.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { listAgentCapabilityProviders } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";

class MemoryConfigStore {
  rows = new Map();
  key(value) { return `${value.teamName}\0${value.agentName}`; }
  async get(key) { return this.rows.get(this.key(key)) ?? null; }
  async put(key, value) { this.rows.set(this.key(key), structuredClone(value)); }
  async delete(key) { return this.rows.delete(this.key(key)); }
  async purgeSkillReference() { return []; }
}

function skillMarkdown(name = "review-code") {
  return `---\nname: ${name}\ndescription: Review code\nmetadata:\n  custom_flag: true\n---\nReview the code.\n`;
}

test("Skills config remains separate from enabled Skill bindings", async () => {
  const service = new SkillsAgentConfigService(new MemoryConfigStore());
  await service.put({ teamName: "product", agentName: "writer" }, { enabled_skills: ["review-code"] });
  assert.deepEqual(await service.getEffective({ teamName: "product", agentName: "writer" }), { enabled_skills: ["review-code"] });
  assert.deepEqual(await service.getEffective({ teamName: "default", agentName: "writer" }), { enabled_skills: [] });
});

test("skills agent capability provider returns a truncated SKILL.md preview via getItemDetail", async () => {
  const longContent = `${"x".repeat(100)}\n`.repeat(80); // 8160 chars > 4000 上限
  const manager = new BackendPluginManager([
    createSkillsPlugin({
      runtimeFactory: async () => ({
        library: {
          listSkills: async () => [{ name: "review-code", display_name: "Review Code", description: "Review code" }],
          getSkillDetail: async (name) => {
            if (name !== "review-code") throw new Error(`Skill '${name}' 不存在`);
            return {
              name,
              display_name: "Review Code",
              description: "Review code",
              source_type: "builtin",
              source_label: "builtin",
              content: longContent,
              files: [
                { name: "SKILL.md", path: "SKILL.md", type: "file" },
                { name: "refs", path: "refs", type: "directory" },
                { name: "extra.md", path: "refs/extra.md", type: "file" },
              ],
              writable: false,
            };
          },
        },
        agentConfig: {
          getEffective: async () => ({ enabled_skills: [] }),
          put: async () => undefined,
        },
        tools: null,
      }),
    }),
  ]);
  await manager.register();
  const runtime = await manager.runtimeContributions().createRuntime({ deploymentKind: "local", tenantId: "tenant-test" });
  const provider = listAgentCapabilityProviders(runtime.capabilities).find((item) => item.id === "skills");
  assert.ok(provider);

  const detail = await provider.getItemDetail("review-code");
  assert.equal(detail.name, "review-code");
  assert.equal(detail.detail.content_truncated, true);
  assert.equal(detail.detail.content_preview.length, 4_001); // 4000 + 省略号
  assert.deepEqual(detail.detail.files, ["SKILL.md", "refs/extra.md"]);
  assert.match(detail.detail.note, /get_skill/);

  assert.equal(await provider.getItemDetail("missing"), null);
});

test("Skill tools expose execution only for explicitly enabled Skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tools-"));
  try {
    const builtinRoot = path.join(root, "builtin", "review-code");
    fs.mkdirSync(builtinRoot, { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, "SKILL.md"), skillMarkdown());
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin") });
    const agent = { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} };
    assert.equal(createSkillTools({ skillTools: service, agent, config: { enabled_skills: [] } }).length, 0);
    const tools = createSkillTools({ skillTools: service, agent, config: { enabled_skills: ["review-code"] } });
    assert.deepEqual(tools.map((tool) => tool.name), ["activate_skill", "load_skill_resource", "execute_skill_script"]);
    const activate = tools.find((tool) => tool.name === "activate_skill");
    assert.deepEqual(activate.parameters.properties.skill_name.enum, ["review-code"]);
    assert.match(activate.parameters.properties.skill_name.description, /review-code: Review code/);
    assert.equal(activate.extendedUsage, undefined);
    const execute = tools.find((tool) => tool.name === "execute_skill_script");
    assert.equal(execute.parameters.properties.timeout.type, "integer");
    assert.equal(execute.parameters.properties.timeout.minimum, 1);
    assert.equal(execute.parameters.properties.timeout.maximum, 300);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("execute_skill_script runs from the shared workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-workspace-"));
  try {
    const builtinRoot = path.join(root, "builtin", "review-code");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(builtinRoot, "scripts"), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, "SKILL.md"), skillMarkdown());
    fs.writeFileSync(path.join(builtinRoot, "scripts", "check.py"), [
      "import json",
      "import os",
      "from pathlib import Path",
      "request = Path(__import__('sys').argv[1]).read_text(encoding='utf-8')",
      "Path('script-output.txt').write_text(request, encoding='utf-8')",
      "print(json.dumps({'cwd': os.getcwd(), 'workspace': os.environ['SESSION_WORKSPACE_DIR'], 'request': request}))",
    ].join("\n"));
    fs.writeFileSync(path.join(workspace, "request.json"), "{\"ok\":true}\n");
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin") });
    const result = await service.executeSkillScript(
      { skillName: "review-code", scriptName: "check.py", arguments: ["request.json"] },
      { sessionId: "session-skill", runId: "run-skill", workspaceRoot: workspace },
      { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} },
      { enabled_skills: ["review-code"] },
    );
    assert.equal(result.success, true, result.summary);
    assert.equal(result.content.cwd, workspace);
    assert.equal(result.content.workspace, workspace);
    assert.equal(result.content.request, "{\"ok\":true}\n");
    assert.equal(fs.readFileSync(path.join(workspace, "script-output.txt"), "utf8").replaceAll("\r\n", "\n"), "{\"ok\":true}\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeSlowSkill(root) {
  const builtinRoot = path.join(root, "builtin", "review-code");
  fs.mkdirSync(path.join(builtinRoot, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(builtinRoot, "SKILL.md"), skillMarkdown());
  fs.writeFileSync(path.join(builtinRoot, "scripts", "slow.py"), "import time\ntime.sleep(30)\n");
  return path.join(root, "builtin");
}

test("normalizeScriptTimeout falls back to the default and clamps into range", () => {
  assert.equal(DEFAULT_SCRIPT_TIMEOUT_SECONDS, 60);
  assert.equal(MAX_SCRIPT_TIMEOUT_SECONDS, 300);
  assert.equal(normalizeScriptTimeout(null), 60);
  assert.equal(normalizeScriptTimeout(undefined), 60);
  assert.equal(normalizeScriptTimeout(45), 45);
  assert.equal(normalizeScriptTimeout(300), 300);
  assert.equal(normalizeScriptTimeout(-5), 1);
  assert.equal(normalizeScriptTimeout(45.5), 60);
  assert.equal(normalizeScriptTimeout(0), 1);
  assert.equal(normalizeScriptTimeout(1), 1);
  assert.equal(normalizeScriptTimeout(9999), 300);
});

test("execute_skill_script honors the caller timeout and kills overdue scripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-timeout-"));
  try {
    const builtinSkillsRoot = writeSlowSkill(root);
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot });
    const result = await service.executeSkillScript(
      { skillName: "review-code", scriptName: "slow.py", timeoutSeconds: 1 },
      { sessionId: "session-skill", runId: "run-skill" },
      { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} },
      { enabled_skills: ["review-code"] },
    );
    assert.equal(result.success, true, result.summary);
    assert.equal(result.content.return_code, 124);
    assert.equal(result.content.stderr, "脚本执行超时（>1秒）");
    assert.equal(result.metadata.timeout_seconds, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run_in_background passes the caller timeout through to the background run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-bg-timeout-"));
  try {
    const builtinSkillsRoot = writeSlowSkill(root);
    let backgroundRun = null;
    const backgroundTasks = {
      spawnBash: () => { throw new Error("unexpected spawnBash"); },
      runCallable: (input) => {
        backgroundRun = Promise.resolve(input.run({ taskId: "task-bg-skill", signal: new AbortController().signal })).catch((error) => error);
        return {
          task_id: "task-bg-skill",
          description: input.description,
          output_path: path.join(root, "bg-output.log"),
          started_at: Date.now(),
          status: "running",
          return_code: null,
          error: null,
          expires_at: null,
          run_id: input.runId ?? null,
          owner_task_id: input.ownerTaskId ?? null,
          session_id: input.sessionId ?? null,
          initiator_thread_key: input.initiatorThreadKey ?? null,
          initiator_child_agent_id: input.initiatorChildAgentId ?? null,
          completed_at: null,
          result_type: input.resultType ?? null,
          kind: input.kind ?? "callable",
          cancel_supported: true,
        };
      },
    };
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot, backgroundTasks });
    const result = await service.executeSkillScript(
      { skillName: "review-code", scriptName: "slow.py", runInBackground: true, timeoutSeconds: 1 },
      { sessionId: "session-skill", runId: "run-skill" },
      { agent_name: "writer", default_entry: false, tasks: { background: true }, custom_params: {} },
      { enabled_skills: ["review-code"] },
    );
    assert.equal(result.metadata.background_started, true, result.summary);
    const inner = await backgroundRun;
    assert.equal(inner.success, true, inner.summary);
    assert.equal(inner.content.return_code, 124);
    assert.equal(inner.content.stderr, "脚本执行超时（>1秒）");
    assert.equal(inner.metadata.timeout_seconds, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skill source resources require absolute roots", () => {
  assert.throws(() => resolveBuiltinSkillSources([
    provideBackendResource(SKILL_SOURCE_RESOURCE, "relative", "bad"),
  ]), /absolute path/);
});
