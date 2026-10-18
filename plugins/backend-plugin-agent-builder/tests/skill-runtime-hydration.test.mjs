import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentBuilderTeam } from "../dist/team-template.js";
import { hydrateSkillAuthoring } from "../dist/skill-authoring-hydration.js";

const current = buildAgentBuilderTeam().builder_orchestrator.custom_params.behavior.system_prompt;
const start = current.indexOf("Use list_skills, with a query when needed");
const end = "A Skill becomes available to Agents when saving succeeds.";
const instruction = current.slice(start, current.indexOf(end, start) + end.length);

for (const version of [undefined, 7, 17]) {
  for (const retired of ["The current Skill runtime executes Python only.", "Use execute_skill_script.", "Use load_skill_resource."]) {
    test(`Skill runtime hydration converges version ${version}, ${retired}`, () => {
      const configs = buildAgentBuilderTeam();
      const behavior = configs.builder_orchestrator.custom_params.behavior;
      if (version === undefined) delete behavior.builder_template_version;
      else behavior.builder_template_version = version;
      behavior.system_prompt = `Keep my prefix. Skill authoring runtime contract: Skill direct-save workflow: ${retired} ${end} Keep my suffix.`;
      const hydrated = hydrateSkillAuthoring(configs, instruction);
      assert.ok(hydrated);
      const prompt = hydrated.builder_orchestrator.custom_params.behavior.system_prompt;
      assert.match(prompt, /^Keep my prefix\./);
      assert.match(prompt, /Keep my suffix\.$/);
      assert.match(prompt, /Skill activation-only workflow:/);
      assert.doesNotMatch(prompt, /execute_skill_script|load_skill_resource|runtime executes Python only/);
      assert.equal(hydrated.builder_orchestrator.custom_params.behavior.skill_authoring_migration.id, "builder_skill_direct_save");
      assert.equal(hydrateSkillAuthoring(hydrated, instruction), null);
    });
  }
}
