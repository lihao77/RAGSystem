import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SkillsAgentConfigService,
  SkillToolService,
  createSkillTools,
  resolveBuiltinSkillSources,
  SKILL_SOURCE_RESOURCE,
} from "../dist/index.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";

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

test("Skill source resources require absolute roots", () => {
  assert.throws(() => resolveBuiltinSkillSources([
    provideBackendResource(SKILL_SOURCE_RESOURCE, "relative", "bad"),
  ]), /absolute path/);
});
