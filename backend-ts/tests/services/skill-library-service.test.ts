import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillLibraryService } from "../../src/services/skills/skill-library-service.js";
import { AgentConfigService } from "../../src/services/agent/config/index.js";
import { FileAgentConfigTeamStore } from "../../src/adapters/filesystem/agent/file-team-store.js";
import { FilesystemSkillPackageStore } from "../../src/adapters/filesystem/skills/filesystem-skill-package-store.js";
import { SkillToolService } from "../../src/tools/SkillTools/SkillExecution.js";
import { HttpError } from "../../src/utils/errors.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-lib-"));
  tempRoots.push(root);
  return root;
}

function writeSkillMd(dir: string, name: string, description: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${content}\n`, "utf8");
}

function makeService(root: string): {
  library: SkillLibraryService;
  skillTools: SkillToolService;
  agentConfig: AgentConfigService;
} {
  const agentConfig = new AgentConfigService(new FileAgentConfigTeamStore({ dataRoot: root }));
  const userGlobal = path.join(root, "global");
  const skillTools = new SkillToolService({
    dataRoot: root,
    builtinSkillsRoot: path.join(root, "builtin"),
    userGlobalSkillsRoot: userGlobal,
    agentConfig,
  });
  agentConfig.setSkillToolService(skillTools);
  const packageStore = new FilesystemSkillPackageStore(userGlobal);
  return { library: new SkillLibraryService(skillTools, packageStore), skillTools, agentConfig };
}

async function makeInitializedService(root: string): Promise<{
  library: SkillLibraryService;
  skillTools: SkillToolService;
  agentConfig: AgentConfigService;
}> {
  const created = makeService(root);
  await created.agentConfig.initialize();
  return created;
}

async function expectHttp(statusCode: number, fn: () => unknown): Promise<void> {
  try {
    await fn();
    throw new Error(`expected HttpError ${statusCode}, nothing threw`);
  } catch (e) {
    if (e instanceof HttpError) {
      expect(e.statusCode).toBe(statusCode);
      return;
    }
    throw e;
  }
}

describe("SkillLibraryService", () => {
  it("creates a user_global skill and reads it back", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    const detail = await library.createSkill({ name: "my-skill", description: "hello", content: "# Hello\n" });
    expect(detail.source_type).toBe("user_global");
    expect(detail.writable).toBe(true);
    expect(detail.content.trim()).toBe("# Hello");
    expect(detail.name).toBe("my-skill");
    expect(detail.description).toBe("hello");
    expect((await library.listSkills()).map((s) => s.name)).toContain("my-skill");
  });

  it("rejects invalid skill names and empty descriptions", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    await expectHttp(400, () => library.createSkill({ name: "BadName", description: "x", content: "" }));
    await expectHttp(400, () => library.createSkill({ name: "with/slash", description: "x", content: "" }));
    await expectHttp(400, () => library.createSkill({ name: "ok", description: "   ", content: "" }));
  });

  it("rejects duplicate name", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    await library.createSkill({ name: "dup", description: "first", content: "" });
    await expectHttp(409, () => library.createSkill({ name: "dup", description: "second", content: "" }));
  });

  it("updates description and content of a user_global skill", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    await library.createSkill({ name: "edit", description: "old", content: "old body" });
    const updated = await library.updateSkillMd("edit", { description: "new desc", content: "new body" });
    expect(updated.description).toBe("new desc");
    expect(updated.content.trim()).toBe("new body");
  });

  it("writes and reads script files, rejecting traversal and disallowed dirs", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    await library.createSkill({ name: "with-scripts", description: "d", content: "" });
    const detail = await library.writeSkillFile("with-scripts", "scripts/foo.py", Buffer.from("print(1)"));
    expect(detail.files.map((f) => f.path)).toContain("scripts/foo.py");
    const read = await library.readSkillFile("with-scripts", "scripts/foo.py");
    expect(read.buffer.toString("utf8")).toBe("print(1)");
    expect(read.mime).toContain("python");
    await expectHttp(400, () => library.writeSkillFile("with-scripts", "scripts/../foo.py", Buffer.from("x")));
    await expectHttp(400, () => library.writeSkillFile("with-scripts", "docs/x.md", Buffer.from("x")));
    await expectHttp(400, () => library.writeSkillFile("with-scripts", "SKILL.md", Buffer.from("x")));
  });

  it("deletes a user_global skill", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    await library.createSkill({ name: "todelete", description: "d", content: "" });
    await library.deleteSkill("todelete");
    expect((await library.listSkills()).map((s) => s.name)).not.toContain("todelete");
    await expectHttp(404, () => library.getSkillDetail("todelete"));
  });

  it("forbids writing / deleting builtin skills but allows user_global", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    writeSkillMd(path.join(root, "builtin", "bi"), "bi", "builtin", "# Builtin\n");
    writeSkillMd(path.join(root, "global", "ug"), "ug", "global", "# Global\n");
    await expectHttp(403, () => library.updateSkillMd("bi", { content: "x" }));
    await expectHttp(403, () => library.writeSkillFile("bi", "scripts/x.py", Buffer.from("x")));
    await expectHttp(403, () => library.deleteSkill("bi"));
    expect((await library.getSkillDetail("ug")).writable).toBe(true);
    await library.deleteSkill("ug");
    await expectHttp(404, () => library.getSkillDetail("ug"));
  });

  it("readSkillFile rejects out-of-tree and missing paths", async () => {
    const root = makeRoot();
    const { library } = makeService(root);
    await library.createSkill({ name: "rf", description: "d", content: "" });
    await expectHttp(400, () => library.readSkillFile("rf", "../outside.txt"));
    await expectHttp(404, () => library.readSkillFile("rf", "missing.txt"));
  });

  it("deletes a skill and purges its references from all agent configs", async () => {
    const root = makeRoot();
    const { library, agentConfig } = await makeInitializedService(root);
    await library.createSkill({ name: "will-delete", description: "d", content: "" });
    await agentConfig.createAgent({ agent_name: "a1", default_entry: false });
    await agentConfig.createAgent({ agent_name: "a2", default_entry: false });
    await agentConfig.patchConfig("a1", { skills: { enabled_skills: ["will-delete"] } });
    await agentConfig.patchConfig("a2", { skills: { enabled_skills: ["will-delete", "keep"] } });
    expect(agentConfig.getConfig("a1")?.skills.enabled_skills).toContain("will-delete");

    const res = await library.deleteSkill("will-delete");

    expect(res.purged_agents.length).toBe(2);
    expect(agentConfig.getConfig("a1")?.skills.enabled_skills ?? []).not.toContain("will-delete");
    expect(agentConfig.getConfig("a2")?.skills.enabled_skills ?? []).not.toContain("will-delete");
    expect(agentConfig.getConfig("a2")?.skills.enabled_skills ?? []).toContain("keep");
  });
});
