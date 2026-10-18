import { z } from "zod";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import type { SkillsAgentConfig } from "../config.js";
import type { SkillToolService } from "./SkillExecution.js";

interface SkillToolDeps {
  skillTools: SkillToolService | null;
  agent: AgentConfig | null;
  config: SkillsAgentConfig;
  pathService: PathAccessPolicy;
}

/** Skills contribute one instruction-loading tool; files and execution use the ordinary tools. */
export function createSkillTools(deps: SkillToolDeps): Tool[] {
  const service = deps.skillTools;
  if (!service) return [];
  const skills = service.listVisibleSkills(deps.agent, deps.config);
  if (!skills.length) return [];
  const candidates = skills.map((skill) => {
    const requires = skill.requires?.mcp_servers?.length ? `; requires MCP: ${skill.requires.mcp_servers.join(", ")}` : "";
    return `${skill.name}: ${skill.description}${requires}`;
  }).join("; ");
  return [buildTool({
    name: "activate_skill",
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    allowedCallers: ["direct"],
    observationPolicy: "inline",
    description: "Load SKILL.md instructions and return the absolute skill_root. Read supporting files with read_file, discover files with glob/grep, and run scripts through execute_shell using the existing local environment. Keep task inputs and outputs in the task workspace. Activation does not execute scripts or install dependencies.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name"],
      properties: {
        skill_name: { type: "string", enum: skills.map((skill) => skill.name), description: `Allowed candidates: ${candidates}` },
      },
    },
    inputSchema: z.object({ skill_name: z.string().min(1) }).strict(),
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: (input: { skill_name: string }, context: ToolExecContext) => service.activateSkill(
      { skillName: input.skill_name }, context, deps.agent, deps.config, deps.pathService,
    ),
  })];
}
