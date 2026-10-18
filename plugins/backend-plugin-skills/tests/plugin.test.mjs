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

test("Skill tools expose only activation for visible Skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-tools-"));
  try {
    const builtinRoot = path.join(root, "builtin", "review-code");
    fs.mkdirSync(builtinRoot, { recursive: true });
    fs.writeFileSync(path.join(builtinRoot, "SKILL.md"), skillMarkdown());
    const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin") });
    const agent = { agent_name: "writer", default_entry: false, tasks: { background: false }, custom_params: {} };
    assert.equal(createSkillTools({ skillTools: service, agent, config: { enabled_skills: [] } }).length, 0);
    const tools = createSkillTools({ skillTools: service, agent, config: { enabled_skills: ["review-code"] } });
    assert.deepEqual(tools.map((tool) => tool.name), ["activate_skill"]);
    const activate = tools.find((tool) => tool.name === "activate_skill");
    assert.deepEqual(activate.parameters.properties.skill_name.enum, ["review-code"]);
    assert.match(activate.parameters.properties.skill_name.description, /review-code: Review code/);
    assert.equal(activate.extendedUsage, undefined);
    assert.deepEqual(Object.keys(activate.parameters.properties), ["skill_name"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skill source resources require absolute roots", () => {
  assert.throws(() => resolveBuiltinSkillSources([
    provideBackendResource(SKILL_SOURCE_RESOURCE, "relative", "bad"),
  ]), /absolute path/);
});
