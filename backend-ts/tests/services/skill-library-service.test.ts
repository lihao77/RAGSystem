import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillLibraryService } from "../../src/services/skills/skill-library-service.js";
import { AgentConfigService } from "../../src/services/agent/config/index.js";
import { FileAgentConfigTeamStore } from "../../src/adapters/filesystem/agent/file-team-store.js";
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
  const skillTools = new SkillToolService({
    dataRoot: root,
    builtinSkillsRoot: path.join(root, "builtin"),
    userGlobalSkillsRoot: path.join(root, "global"),
    agentConfig,
  });
  agentConfig.setSkillToolService(skillTools);
  return { library: new SkillLibraryService(skillTools), skillTools, agentConfig };
}

function expectHttp(statusCode: number, fn: () => unknown): void {
  try {
    fn();
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
  it("creates a user_global skill and reads it back", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    const detail = library.createSkill({ name: "my-skill", description: "hello", content: "# Hello\n" });
    expect(detail.source_type).toBe("user_global");
    expect(detail.writable).toBe(true);
    expect(detail.content).toBe("# Hello");
    expect(detail.name).toBe("my-skill");
    expect(detail.description).toBe("hello");
    expect(library.listSkills().map((s) => s.name)).toContain("my-skill");
  });

  it("rejects invalid skill names and empty descriptions", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    expectHttp(400, () => library.createSkill({ name: "BadName", description: "x", content: "" }));
    expectHttp(400, () => library.createSkill({ name: "with/slash", description: "x", content: "" }));
    expectHttp(400, () => library.createSkill({ name: "ok", description: "   ", content: "" }));
  });

  it("rejects duplicate name", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    library.createSkill({ name: "dup", description: "first", content: "" });
    expectHttp(409, () => library.createSkill({ name: "dup", description: "second", content: "" }));
  });

  it("updates description and content of a user_global skill", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    library.createSkill({ name: "edit", description: "old", content: "old body" });
    const updated = library.updateSkillMd("edit", { description: "new desc", content: "new body" });
    expect(updated.description).toBe("new desc");
    expect(updated.content).toBe("new body");
  });

  it("writes and reads script files, rejecting traversal and disallowed dirs", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    library.createSkill({ name: "with-scripts", description: "d", content: "" });
    const detail = library.writeSkillFile("with-scripts", "scripts/foo.py", Buffer.from("print(1)"));
    expect(detail.files.map((f) => f.path)).toContain("scripts/foo.py");
    const read = library.readSkillFile("with-scripts", "scripts/foo.py");
    expect(read.buffer.toString("utf8")).toBe("print(1)");
    expect(read.mime).toContain("python");
    expectHttp(400, () => library.writeSkillFile("with-scripts", "scripts/../foo.py", Buffer.from("x")));
    expectHttp(400, () => library.writeSkillFile("with-scripts", "docs/x.md", Buffer.from("x")));
    expectHttp(400, () => library.writeSkillFile("with-scripts", "SKILL.md", Buffer.from("x")));
  });

  it("deletes a user_global skill", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    library.createSkill({ name: "todelete", description: "d", content: "" });
    library.deleteSkill("todelete");
    expect(library.listSkills().map((s) => s.name)).not.toContain("todelete");
    expectHttp(404, () => library.getSkillDetail("todelete"));
  });

  it("forbids writing / deleting builtin skills but allows user_global", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    writeSkillMd(path.join(root, "builtin", "bi"), "bi", "builtin", "# Builtin\n");
    writeSkillMd(path.join(root, "global", "ug"), "ug", "global", "# Global\n");
    expectHttp(403, () => library.updateSkillMd("bi", { content: "x" }));
    expectHttp(403, () => library.writeSkillFile("bi", "scripts/x.py", Buffer.from("x")));
    expectHttp(403, () => library.deleteSkill("bi"));
    expect(library.getSkillDetail("ug").writable).toBe(true);
    library.deleteSkill("ug");
    expectHttp(404, () => library.getSkillDetail("ug"));
  });

  it("readSkillFile rejects out-of-tree and missing paths", () => {
    const root = makeRoot();
    const { library } = makeService(root);
    library.createSkill({ name: "rf", description: "d", content: "" });
    expectHttp(400, () => library.readSkillFile("rf", "../outside.txt"));
    expectHttp(404, () => library.readSkillFile("rf", "missing.txt"));
  });

  it("deletes a skill and purges its references from all agent configs", () => {
    const root = makeRoot();
    const { library, agentConfig } = makeService(root);
    library.createSkill({ name: "will-delete", description: "d", content: "" });
    agentConfig.createAgent({ agent_name: "a1", default_entry: false });
    agentConfig.createAgent({ agent_name: "a2", default_entry: false });
    agentConfig.patchConfig("a1", { skills: { enabled_skills: ["will-delete"] } });
    agentConfig.patchConfig("a2", { skills: { enabled_skills: ["will-delete", "keep"] } });
    expect(agentConfig.getConfig("a1")?.skills.enabled_skills).toContain("will-delete");

    const res = library.deleteSkill("will-delete");

    expect(res.purged_agents.length).toBe(2);
    expect(agentConfig.getConfig("a1")?.skills.enabled_skills ?? []).not.toContain("will-delete");
    expect(agentConfig.getConfig("a2")?.skills.enabled_skills ?? []).not.toContain("will-delete");
    expect(agentConfig.getConfig("a2")?.skills.enabled_skills ?? []).toContain("keep");
  });
});
