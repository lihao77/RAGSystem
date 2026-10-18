import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { FilesystemSkillPackageStore, SkillAuthoringService, SkillToolService, createSkillAuthoringTools, createSkillsPlugin, validateSkillBundle } from "../dist/index.js";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { listAgentCapabilityProviders } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";
import { SkillLibraryService } from "../dist/services/skill-library-service.js";
import { createSkillAuthoringAuthorization } from "../dist/authoring-authorization.js";
import { registerSkillRoutes } from "../dist/routes.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";

function bundle(content = "Useful instructions.", name = "example") {
  return validateSkillBundle(name, [
    { relativePath: "SKILL.md", body: Buffer.from(`---\nname: ${name}\ndescription: Example\nmetadata:\n  custom: true\n---\n${content}\n`) },
    { relativePath: "scripts/check.py", body: Buffer.from(`print(${JSON.stringify(content)})`) },
    { relativePath: "assets/data.bin", body: Buffer.from([0, 255, 13]) },
  ]);
}
function input(value = bundle(), revision = null) {
  return { expected_revision: revision, files: value.files.map((file) => ({ relative_path: file.relativePath, body_base64: Buffer.from(file.body).toString("base64") })) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-direct-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new FilesystemSkillPackageStore(path.join(root, "skills"));
  const tools = new SkillToolService({ dataRoot: root, userGlobalSkillsRoot: path.join(root, "skills"), builtinSkillsRoot: path.join(root, "builtin"), packageStore: store });
  const library = new SkillLibraryService(tools, store);
  const authoring = new SkillAuthoringService(library);
  return { root, store, tools, library, authoring };
}

test("Skill discovery reads metadata only and observes live directory edits", async (t) => {
  const { root, store, tools, library } = fixture(t);
  await store.createBundle(bundle());
  const readFile = fs.readFileSync;
  const reads = [];
  try {
    fs.readFileSync = (file, ...args) => {
      reads.push(String(file));
      assert.equal(path.basename(String(file)), "SKILL.md", "discovery must not read scripts or assets");
      return readFile(file, ...args);
    };
    const listed = await library.listSkills();
    assert.deepEqual(listed.map((skill) => [skill.name, skill.source_type]), [["example", "user_global"]]);
    assert.equal(reads.length, 1);
    assert.equal(fs.existsSync(path.join(root, "skills/.runtime")), false);
    assert.equal(tools.loadAllSkills()[0].skillDir, path.join(root, "skills/example"));
  } finally { fs.readFileSync = readFile; }

  await tools.hydrateUserGlobalMetadata();
  const previous = tools.loadAllSkills()[0];
  assert.equal(previous.skillDir, path.join(root, "skills/example"));
  const revision = (await store.readBundle("example")).revision;
  await store.saveBundle(bundle("Updated instructions"), revision);
  const markdown = path.join(root, "skills/example/SKILL.md");
  fs.writeFileSync(markdown, fs.readFileSync(markdown, "utf8").replace("description: Example", "description: Edited externally"));
  assert.equal((await library.listSkills())[0].description, "Edited externally");
  assert.equal(tools.loadAllSkills()[0].skillDir, previous.skillDir);
  assert.match(fs.readFileSync(path.join(previous.skillDir, "SKILL.md"), "utf8"), /Updated instructions/);
  await tools.hydrateUserGlobalMetadata();
  assert.equal(tools.loadAllSkills()[0].skillDir, previous.skillDir);
  await store.delete("example");
  assert.deepEqual(await library.listSkills(), []);
});

test("metadata discovery preserves workspace/global/builtin precedence and legacy-store fallback", async (t) => {
  const { root, store, tools } = fixture(t);
  await store.createBundle(bundle());
  for (const [directory, description] of [["builtin/example", "Builtin"], [".ragsystem/skills/example", "Workspace"]]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, "SKILL.md"), `---\nname: example\ndescription: ${description}\n---\nBody\n`);
  }
  assert.equal((await tools.listAvailableSkillsAsync())[0].source_type, "user_global");
  assert.equal((await tools.listAvailableSkillsAsync(root))[0].source_type, "workspace");
  store.listMetadata = undefined;
  assert.equal((await tools.listAvailableSkillsAsync())[0].source_type, "user_global");
  assert.equal(tools.loadAllSkills()[0].skillDir, path.join(root, "skills/example"));
});


test("activation returns only the selected live package without execution snapshots", async (t) => {
  const { root, store, tools } = fixture(t);
  await store.createBundle(bundle());
  await store.createBundle(bundle("Unrelated instructions", "unrelated"));
  const selected = [];
  const get = store.get.bind(store);
  store.list = async () => assert.fail("tool preparation must not load all package files");
  store.get = async (name) => { selected.push(name); return get(name); };
  const config = { enabled_skills: ["example"] };
  const context = { workspaceRoot: root };
  const agent = { agent_name: "writer", default_entry: false, custom_params: {} };
  const activated = await tools.activateSkill({ skillName: "example" }, context, agent, config);
  assert.equal(activated.success, true);
  assert.equal(activated.content.skill_root, fs.realpathSync(path.join(root, "skills/example")));
  assert.match(activated.content.main_content, /Useful instructions/);
  assert.deepEqual(selected, ["example"]);
  assert.equal(fs.existsSync(path.join(root, "skills/.runtime")), false);
  const denied = await tools.activateSkill({ skillName: "unrelated" }, context, agent, config);
  assert.equal(denied.success, false);
  assert.doesNotMatch(denied.content, /Unrelated instructions/);
  assert.deepEqual(selected, ["example"]);
});

test("plugin tool assembly and capability inventory preserve metadata without execution hydration", async (t) => {
  const { root, store, tools, library, authoring } = fixture(t);
  const value = bundle();
  value.files[0].body = Buffer.from(Buffer.from(value.files[0].body).toString().replace("custom: true", "custom: true\n  ragsystem_requires_tools: execute_code"));
  await store.createBundle(value);
  store.list = async () => assert.fail("assembling tools must not list execution snapshots");
  const manager = new BackendPluginManager([createSkillsPlugin({ runtimeFactory: async () => ({
    tools, library, authoring, agentConfig: { getEffective: async () => ({ enabled_skills: ["example"] }) },
  }) })]);
  await manager.register();
  const contributions = manager.runtimeContributions();
  const runtime = await contributions.createRuntime({ deploymentKind: "local", tenantId: "test" });
  const provider = listAgentCapabilityProviders(runtime.capabilities).find((item) => item.id === "skills");
  assert.deepEqual((await provider.listItems())[0].metadata.requires, { tools: ["execute_code"] });
  const prepared = await contributions.createTools({ agent: { agent_name: "writer", tools: { enabled_tools: [] }, custom_params: {} }, teamName: "default", capabilities: runtime.capabilities });
  assert.deepEqual(prepared.map((tool) => tool.name), ["activate_skill"]);
  assert.equal(fs.existsSync(path.join(root, "skills/.runtime")), false);
  runtime.dispose();
});

test("new workspace is unavailable until a validated complete save; subsequent saves preserve all files", async (t) => {
  const { root, authoring, library } = fixture(t);
  const workspace = await authoring.openWorkspace("example", root, "Example");
  assert.deepEqual(await library.listSkills(), []);
  await assert.rejects(authoring.saveWorkspace(workspace.workspace_path, root));
  assert.deepEqual(await library.listSkills(), []);
  for (const file of bundle().files) {
    const target = path.join(root, workspace.workspace_path, file.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.body);
  }
  const result = await authoring.saveWorkspace(workspace.workspace_path, root);
  assert.equal(result.available_for_binding, true);
  assert.equal(result.files, undefined);
  assert.equal((await library.listSkills()).length, 1);
  const saved = await authoring.getBundle("example");
  assert.equal(saved.files.length, 3);
  assert.equal(saved.status, undefined);
  fs.writeFileSync(path.join(root, workspace.workspace_path, "scripts/check.py"), 'print("updated")');
  const updated = await authoring.saveWorkspace(workspace.workspace_path, root);
  assert.notEqual(updated.revision, result.revision);
  assert.equal((await authoring.saveWorkspace(workspace.workspace_path, root)).revision, updated.revision);
  const openedAgain = await authoring.openWorkspace("example", root);
  assert.notEqual(openedAgain.workspace_path, workspace.workspace_path);
  assert.equal(fs.existsSync(path.join(root, workspace.workspace_path, "SKILL.md")), true);
});

test("concurrent editors get 409, validation failures preserve the current Skill, deletes check revision", async (t) => {
  const { authoring, library } = fixture(t);
  const first = await authoring.saveBundle("example", input());
  const outcomes = await Promise.allSettled([
    authoring.saveBundle("example", input(bundle("writer A"), first.revision)),
    authoring.saveBundle("example", input(bundle("writer B"), first.revision)),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((entry) => entry.status === "rejected").reason.statusCode, 409);
  const current = await authoring.getBundle("example");
  for (const bad of [
    { ...input(), files: [] },
    { ...input(), files: [{ relative_path: "../evil", body_base64: "eA==" }] },
    { ...input(), files: [...input().files, { relative_path: "skill.md", body_base64: "eA==" }] },
    { ...input(), files: [{ relative_path: "SKILL.md", body_base64: "invalid!" }] },
    { ...input(), files: [...input().files, { relative_path: "manifest.json", body_base64: "eA==" }] },
    { ...input(), files: [...input().files, { relative_path: "scripts/.cache/data", body_base64: "eA==" }] },
  ]) await assert.rejects(authoring.saveBundle("example", { ...bad, expected_revision: current.revision }));
  assert.deepEqual(await authoring.getBundle("example"), current);
  await assert.rejects(library.deleteSkill("example", first.revision), { statusCode: 409 });
  await library.deleteSkill("example", current.revision);
  assert.deepEqual(await library.listSkills(), []);
});

test("filesystem replacement recovers failure/crash and keeps the live directory stable", async (t) => {
  const { root, store } = fixture(t);
  await store.createBundle(bundle());
  const previous = await store.get("example");
  const snapshot = await store.readBundle("example");
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (path.basename(from).startsWith('.creating-example-')) throw new Error('simulated rename failure');
      return rename(from, to);
    };
    await assert.rejects(store.saveBundle(bundle("new"), snapshot.revision), /simulated/);
  } finally { fs.renameSync = rename; }
  assert.equal((await store.readBundle("example")).revision, snapshot.revision);
  // A process died after moving the live directory out of the way.
  fs.renameSync(path.join(root, "skills/example"), path.join(root, "skills/.replacing-example"));
  assert.equal((await store.readBundle("example")).revision, snapshot.revision);
  await store.saveBundle(bundle("new"), snapshot.revision);
  const current = await store.get("example");
  assert.equal(previous.skillDir, current.skillDir);
  assert.equal(fs.existsSync(path.join(root, "skills/.runtime")), false);
  assert.match(fs.readFileSync(path.join(current.skillDir, "SKILL.md"), "utf8"), /new/);
});

test("Builder checks current user membership on every call; member/disabled/foreign/missing identity cannot mutate", async (t) => {
  const { authoring, root } = fixture(t);
  let role = 'admin', status = 'active';
  const control = {
    memberships: { get: async (user, tenant) => user === 'usr_editor' && tenant === 'tnt_a' ? { role } : null },
    users: { get: async () => ({ status }) }, tenants: { get: async () => ({ status: 'active' }) },
  };
  const authorize = createSkillAuthoringAuthorization([provideBackendResource(BACKEND_HOST_RESOURCES.controlPlane, control, 'test')], 'tnt_a');
  const context = { userId: 'usr_editor', tenantId: 'tnt_a', workspaceRoot: root };
  await authorize(context); role = 'owner'; await authorize(context);
  role = 'member'; await assert.rejects(authorize(context), { statusCode: 403 });
  role = 'admin'; status = 'disabled'; await assert.rejects(authorize(context), { statusCode: 403 });
  status = 'active'; await assert.rejects(authorize({ ...context, tenantId: 'tnt_b' }), { statusCode: 403 });
  await assert.rejects(authorize({}), { statusCode: 403 });
  const tools = createSkillAuthoringTools({ authoring, authorize });
  assert.deepEqual(tools.map((tool) => tool.name), ['list_skills', 'get_skill', 'create_skill', 'save_skill']);
  role = 'member';
  const denied = await tools.find((tool) => tool.name === 'create_skill').call({ name: 'example', description: 'test' }, context);
  assert.equal(denied.success, false);
  assert.equal(fs.existsSync(path.join(root, '.ragsystem')), false);
});

test("HTTP bundle writes/delete require admin; builtin editing stays forbidden", async (t) => {
  const { root, authoring, library, tools } = fixture(t);
  fs.mkdirSync(path.join(root, 'builtin/example'), { recursive: true });
  fs.writeFileSync(path.join(root, 'builtin/example/SKILL.md'), bundle().files[0].body);
  const app = Fastify(); t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.identity = { role: request.headers['x-role'] || 'member' };
    request.container = { pluginCapabilities: { require: () => ({ authoring, library, tools }) } };
  });
  await app.register(registerSkillRoutes, { prefix: '/api/skills' });
  assert.equal((await app.inject('/api/skills/example/bundle')).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/skills/example/bundle', payload: input() })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/skills/example' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/skills/example/bundle', headers: { 'x-role': 'admin' }, payload: input() })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/skills/custom/bundle', headers: { 'x-role': 'owner' }, payload: input(bundle('custom', 'custom')) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/skills/drafts', headers: { 'x-role': 'admin' }, payload: { name: 'retired' } })).statusCode, 404);
});
