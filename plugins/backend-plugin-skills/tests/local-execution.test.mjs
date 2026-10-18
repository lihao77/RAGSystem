import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import { LocalDocumentToolService } from "@ragsystem/backend-plugin-document-tools/tools/DocumentTools/DocumentExecution.js";
import { LocalDocumentPathManager } from "@ragsystem/backend-plugin-document-tools/tools/DocumentTools/path-manager.js";
import { LocalSearchToolService } from "@ragsystem/backend-plugin-execution-tools/tools/LocalSearchTools/SearchExecution.js";
import { LocalBashToolService } from "@ragsystem/backend-plugin-execution-tools/tools/BashTool/BashExecution.js";
import { FilesystemSkillPackageStore, SkillToolService, createSkillTools, validateSkillBundle } from "../dist/index.js";

async function fixture(t) {
  // Outside the automatically readable/writable OS temp directory, so grants are actually tested.
  const root = fs.mkdtempSync(path.join(process.cwd(), ".skill-activation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const packageRoot = path.join(root, "skills");
  const store = new FilesystemSkillPackageStore(packageRoot);
  const bundle = validateSkillBundle("example", [
    { relativePath: "SKILL.md", body: Buffer.from("---\nname: example\ndescription: Example\n---\nRead supporting files and run scripts with general tools.\n") },
    { relativePath: "scripts/check.cjs", body: Buffer.from("require('fs').writeFileSync('result.txt', 'done'); console.log('done');") },
    { relativePath: "references/guide.md", body: Buffer.from("first line\n中文说明\nthird line\n") },
    { relativePath: "requirements.txt", body: Buffer.from("nonexistent-package-not-to-be-installed\n") },
    { relativePath: "assets/large.bin", body: Buffer.alloc(1024 * 1024) },
  ]);
  // A locally installed directory is sufficient; saving is covered by the authoring tests.
  for (const file of bundle.files) {
    const target = path.join(packageRoot, "example", file.relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.body);
  }
  const service = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin"), packageStore: store });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const context = { sessionId: "test", runId: "test", workspaceRoot: workspace };
  const agent = { agent_name: "writer", default_entry: false, custom_params: {} };
  const config = { enabled_skills: ["example"] };
  const policy = new PathApprovalService();
  const activate = () => service.activateSkill({ skillName: "example" }, context, agent, config, policy);
  return { root, packageRoot, store, service, context, agent, config, policy, workspace, activate };
}

test("activation exposes one tool, live paths and instructions without reading resources or preparing environments", async (t) => {
  const f = await fixture(t);
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.equal(path.basename(String(file)), "SKILL.md", "activation must only read instructions");
    return originalRead(file, ...args);
  };
  try {
    await f.service.hydrateUserGlobalMetadata();
    const tools = createSkillTools({ skillTools: f.service, agent: f.agent, config: f.config, pathService: f.policy });
    assert.deepEqual(tools.map((tool) => tool.name), ["activate_skill"]);
    const result = await tools[0].call({ skill_name: "example" }, f.context);
    assert.equal(result.success, true);
    assert.match(result.content.main_content, /general tools/);
    assert.equal(result.content.skill_root, fs.realpathSync(path.join(f.packageRoot, "example")));
  } finally { fs.readFileSync = originalRead; }
  assert.equal(fs.existsSync(path.join(f.packageRoot, ".runtime")), false);
  assert.equal(fs.existsSync(path.join(f.packageRoot, "example/.venv")), false);
  assert.equal(fs.existsSync(path.join(f.workspace, "result.txt")), false);
});

test("activated resources work with ordinary read_file, glob and grep without granting write access", async (t) => {
  const f = await fixture(t);
  const docs = new LocalDocumentToolService({ dataRoot: f.root });
  const paths = new LocalDocumentPathManager(f.root);
  const search = new LocalSearchToolService({ dataRoot: f.root });
  const source = path.join(f.packageRoot, "example/references/guide.md");
  assert.equal((await docs.readFile({ filePath: source }, f.context, f.agent, f.policy)).success, false);
  const activated = await f.activate();
  assert.equal(activated.success, true);
  const read = await docs.readFile({ filePath: source, offset: 2, limit: 1 }, f.context, f.agent, f.policy);
  assert.equal(read.success, true, read.summary);
  assert.match(read.content, /中文说明/);
  assert.doesNotMatch(read.content, /third line/);
  assert.deepEqual(paths.getExternalCandidates("read_file", { file_path: source }, f.context, f.policy), []);
  assert.deepEqual(search.getSearchRootCandidates(activated.content.skill_root, f.context, f.policy), []);
  assert.equal((await search.glob({ pattern: "**/*.md", path: activated.content.skill_root }, f.context, f.policy)).success, true);
  assert.equal((await search.grep({ pattern: "中文", path: source }, f.context, f.policy)).success, true);
  assert.equal(f.policy.isApproved(source), false);
  assert.ok(paths.getExternalCandidates("write_file", { file_path: source }, f.context, f.policy).length);
  assert.throws(() => paths.resolveManagedPath(source, { context: f.context, operation: "write" }, f.policy), /禁止访问/);
});

test("ordinary execute_shell runs a Skill script in the task workspace", async (t) => {
  const f = await fixture(t);
  const activated = await f.activate();
  const script = path.join(activated.content.skill_root, "scripts/check.cjs").replaceAll("\\", "/");
  const executable = process.execPath.replaceAll("\\", "/");
  const bash = new LocalBashToolService({ dataRoot: f.root });
  const result = await bash.executePlan({
    command: `"${executable}" "${script}"`, cwd: f.workspace,
    timeoutSeconds: 10, description: "Skill CLI", category: "read_only", riskLevel: "low",
    approvalRequired: false, approvalCommands: [], dangerousCommands: [],
    approvalDescription: "", approvalArguments: {}, metadata: {}, runInBackground: false,
  }, f.context);
  assert.equal(result.content.return_code, 0, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(f.workspace, "result.txt"), "utf8"), "done");
});

test("read grants reject sibling paths and symlink escapes and remain isolated per runtime", async (t) => {
  const f = await fixture(t);
  await f.activate();
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  const escape = path.join(f.packageRoot, "example/escape");
  fs.symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(escape, "secret.txt");
  assert.equal(f.policy.isReadApproved(target), false);
  const docs = new LocalDocumentToolService({ dataRoot: f.root });
  assert.equal((await docs.readFile({ filePath: target }, f.context, f.agent, f.policy)).success, false);
  assert.equal(new PathApprovalService().isReadApproved(path.join(f.packageRoot, "example/SKILL.md")), false);
  await assert.rejects(f.store.readFile("example", "escape/secret.txt"), /symlink/);
  await assert.rejects(f.store.readFile("example", "../SKILL.md"), /Invalid Skill file path/);
});

test("single-file library reads do not read the rest of the package", async (t) => {
  const f = await fixture(t);
  const originalRead = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    assert.notEqual(path.basename(String(file)), "large.bin");
    return originalRead(file, ...args);
  };
  try {
    const file = await f.store.readFile("example", "scripts/check.cjs");
    assert.match(Buffer.from(file.body).toString("utf8"), /result.txt/);
    assert.equal(await f.store.readFile("example", "missing.txt"), null);
  } finally { fs.readFileSync = originalRead; }
});
