import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

/** Reserved tenant Team installed by the Agent Builder plugin. */
export const AGENT_BUILDER_TEAM_NAME = "agent-builder";
export const AGENT_BUILDER_TEAM_TEMPLATE_VERSION = 7;

const CAPABILITY_INVENTORY_TOOL = "list_agent_builder_capabilities";

const SKILL_AUTHORING_TOOLS = [
  "list_skill_drafts",
  "get_skill_draft",
  "create_skill_draft",
  "publish_skill_draft",
] as const;

const CAPABILITY_DISCOVERY_PROMPT = "Before creating or updating a Draft, call list_agent_builder_capabilities and bind only the returned Tool, Skill, and MCP Server names. Never invent capability names.";
const SKILL_AUTHORING_PROMPT = `Use list_skill_drafts, with a query when needed, to find reusable Skill drafts. Use get_skill_draft to copy a draft into the current Session workspace, or create_skill_draft to create one from scratch. Edit SKILL.md and its resources with file tools, then call publish_skill_draft. Publishing validates the local bundle; on failure, fix the files and retry. Do not call separate validate or approve tools. A Skill is not available to Agents until publication succeeds.`;
const PREVIOUS_SKILL_AUTHORING_PROMPT = "When the workflow produces reusable domain instructions that are not covered by an existing Skill, call create_skill_artifact to create a complete kind=skill Artifact in the current Session containing the generated SKILL.md and every script or resource needed to run it. This is an ordinary Artifact authoring tool and does not enable or bind any Skill. Wait for the create_skill_artifact result before calling submit_skill_artifact; read the exact content.artifact_id and content.artifact_revision returned by that tool, pass them as artifact_id and expected_revision, and never invent identifiers or submit in the same concurrent tool batch. After validating the complete bundle, use submit_skill_artifact to copy it into a reviewable Skill candidate. A candidate is not an enabled Skill: never reference it from an Agent Blueprint until an administrator publishes it in the Skill Library.";
const LEGACY_SKILL_AUTHORING_PROMPT = "When the workflow produces reusable domain instructions that are not covered by an existing Skill, use the enabled artifact skill-authoring Skill to create a kind=skill Artifact in the current Session containing SKILL.md and every script or resource needed to run it. The bundle may be assembled as JSON with write_file and passed to create_skill_artifact.py through execute_skill_script. Wait for the execute_skill_script result before calling submit_skill_artifact; read the exact content.artifact_id and content.artifact_revision returned by that tool, pass them as artifact_id and expected_revision, and never invent identifiers or submit in the same concurrent tool batch. After validating the complete bundle, use submit_skill_artifact to copy it into a reviewable Skill candidate. A candidate is not an enabled Skill: never reference it from an Agent Blueprint until an administrator publishes it in the Skill Library.";

/**
 * Seed the managed Team once per tenant. Existing user changes are preserved;
 * template migrations must be explicit instead of overwriting a live Team.
 */
export async function ensureAgentBuilderTeam(agentConfig: AgentConfigService): Promise<boolean> {
  const summary = await agentConfig.listTeams();
  if (summary.teams.some((team) => team.team_name === AGENT_BUILDER_TEAM_NAME)) {
    const current = agentConfig.listConfigs({ teamName: AGENT_BUILDER_TEAM_NAME });
    const migrated = migrateAgentBuilderTeam(current);
    if (!migrated) return false;
    await agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, migrated);
    return true;
  }
  await agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, buildAgentBuilderTeam());
  return true;
}

export function buildAgentBuilderTeam(): Record<string, AgentConfig> {
  return {
    builder_orchestrator: builderAgent({
      name: "builder_orchestrator",
      displayName: "Agent Builder Orchestrator",
      description: "Coordinates requirements research, Agent design, evaluation, and bounded optimization.",
      defaultEntry: true,
      tools: [
        "read_file",
        "write_file",
        "edit_file",
        "preview_data_structure",
        "glob",
        "grep",
        "web_fetch",
        "todo_write",
        CAPABILITY_INVENTORY_TOOL,
        "list_agent_drafts",
        "get_agent_draft",
        "create_agent_draft",
        "publish_agent_draft",
        ...SKILL_AUTHORING_TOOLS,
      ],
      delegation: [
        "requirements_researcher",
        "capability_researcher",
        "agent_architect",
        "agent_evaluator",
        "agent_optimizer",
      ],
      goals: true,
      background: true,
      prompt: [
        "You are the Agent Builder Orchestrator.",
        "Turn the user's business request into a reviewable Agent Team, not an immediate production change.",
        "First clarify the outcome, users, inputs, outputs, constraints, and acceptance criteria.",
        "Delegate research, architecture, evaluation, and optimization to the specialized Agents in this Team.",
        CAPABILITY_DISCOVERY_PROMPT,
        "Use list_agent_drafts, with a query when needed, to find a Draft; use get to copy it into the current Session workspace, or create to start a new workspace Draft. Edit blueprint.json with file tools, then call publish; publish performs validation and synchronization automatically.",
        SKILL_AUTHORING_PROMPT,
        "Do not bypass the publish tool or change runtime files. The platform may auto-publish validated drafts when the tenant automation setting is enabled; report whether the draft remained pending or became a published Release, and never auto-activate a Team.",
        "Keep optimization bounded: at most three revisions per build request unless the user explicitly asks to continue.",
      ].join(" "),
    }),
    requirements_researcher: builderAgent({
      name: "requirements_researcher",
      displayName: "Requirements Researcher",
      description: "Clarifies the target workflow, actors, inputs, outputs, constraints, and acceptance criteria.",
      tools: ["read_file", "preview_data_structure", "glob", "grep", "web_fetch"],
      prompt: "Investigate the user's requested workflow. Return a concise requirements brief with actors, triggers, inputs, outputs, constraints, failure cases, and measurable acceptance criteria. Do not create or publish configuration.",
    }),
    capability_researcher: builderAgent({
      name: "capability_researcher",
      displayName: "Capability Researcher",
      description: "Finds reusable Tools, Skills, MCP servers, and existing Agent patterns before proposing new capability.",
      tools: ["read_file", "preview_data_structure", "glob", "grep", "web_fetch"],
      prompt: "Research the capabilities available in this runtime and existing repository patterns. Prefer existing native Tools, Skills, and MCP servers. Report missing capabilities, risks, and the smallest safe extension needed. Do not invent executable backend code.",
    }),
    agent_architect: builderAgent({
      name: "agent_architect",
      displayName: "Agent Architect",
      description: "Designs the Agent roster, entry point, delegation graph, prompts, and capability bindings.",
      tools: ["read_file", "preview_data_structure", "glob", "grep"],
      prompt: "Design a complete Agent Blueprint from the research briefs. Keep the delegation graph acyclic, assign one clear entry Agent, bind only known capabilities, and include acceptance tests. Return structured recommendations to the Orchestrator.",
    }),
    agent_evaluator: builderAgent({
      name: "agent_evaluator",
      displayName: "Agent Evaluator",
      description: "Reviews a candidate Blueprint against acceptance criteria, safety constraints, and runtime feasibility.",
      tools: ["read_file", "preview_data_structure", "glob", "grep"],
      prompt: "Evaluate the current candidate Blueprint against its acceptance criteria and runtime constraints. Identify concrete failures, missing coverage, unsafe permissions, and unnecessary complexity. Return actionable changes; do not publish.",
    }),
    agent_optimizer: builderAgent({
      name: "agent_optimizer",
      displayName: "Agent Optimizer",
      description: "Suggests bounded prompt, delegation, and capability changes based on evaluation findings.",
      tools: ["read_file", "preview_data_structure", "glob", "grep"],
      prompt: "Use evaluation findings to propose the smallest high-impact Blueprint revision. Preserve working behavior, avoid speculative new Tools, and state the expected acceptance-test improvement. Return a patch plan to the Orchestrator.",
    }),
  };
}

function migrateAgentBuilderTeam(configs: Record<string, AgentConfig>): Record<string, AgentConfig> | null {
  const orchestrator = configs.builder_orchestrator;
  if (!orchestrator) return null;
  const customParams = orchestrator.custom_params;
  if (!isRecord(customParams) || !isRecord(customParams.behavior)) return null;
  const behavior = customParams.behavior;
  const version = typeof behavior.builder_template_version === "number"
    ? behavior.builder_template_version
    : null;
  if (version === null || version >= AGENT_BUILDER_TEAM_TEMPLATE_VERSION) return null;

  const existingTools = Array.isArray(orchestrator.tools?.enabled_tools)
    ? orchestrator.tools.enabled_tools
    : [];
  const deprecatedSkillTools = new Set(["update_skill_draft", "update_agent_draft", "submit_skill_artifact", "create_skill_artifact", "search_skill_drafts", "search_agent_drafts"]);
  const enabledTools = existingTools.filter((tool) => !deprecatedSkillTools.has(tool));
  if (!enabledTools.includes(CAPABILITY_INVENTORY_TOOL)) enabledTools.push(CAPABILITY_INVENTORY_TOOL);
  for (const tool of ["read_file", "write_file", "edit_file"] as const) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  for (const tool of ["list_skill_drafts", "get_skill_draft", "create_skill_draft", "publish_skill_draft"] as const) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  for (const tool of ["list_agent_drafts", "get_agent_draft", "create_agent_draft", "publish_agent_draft"] as const) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  const prompt = typeof behavior.system_prompt === "string" ? behavior.system_prompt.trim() : "";
  const withoutLegacyAuthoring = prompt
    .replace(LEGACY_SKILL_AUTHORING_PROMPT, SKILL_AUTHORING_PROMPT)
    .replace(PREVIOUS_SKILL_AUTHORING_PROMPT, SKILL_AUTHORING_PROMPT);
  const withCapabilityDiscovery = withoutLegacyAuthoring.includes("list_agent_builder_capabilities")
    ? withoutLegacyAuthoring
    : `${withoutLegacyAuthoring} ${CAPABILITY_DISCOVERY_PROMPT}`.trim();
  const nextPrompt = withCapabilityDiscovery.includes("publish_skill_draft")
    ? withCapabilityDiscovery
    : `${withCapabilityDiscovery} ${SKILL_AUTHORING_PROMPT}`.trim();
  return {
    ...configs,
    builder_orchestrator: {
      ...orchestrator,
      tools: { ...orchestrator.tools, enabled_tools: enabledTools },
      custom_params: {
        ...customParams,
        behavior: {
          ...behavior,
          system_prompt: nextPrompt,
          builder_template_version: AGENT_BUILDER_TEAM_TEMPLATE_VERSION,
        },
      },
    },
  };
}

interface BuilderAgentInput {
  name: string;
  displayName: string;
  description: string;
  prompt: string;
  defaultEntry?: boolean;
  tools?: string[];
  delegation?: string[];
  goals?: boolean;
  background?: boolean;
}

function builderAgent(input: BuilderAgentInput): AgentConfig {
  return {
    agent_name: input.name,
    display_name: input.displayName,
    description: input.description,
    enabled: true,
    default_entry: input.defaultEntry ?? false,
    llm_tiers: null,
    tools: { enabled_tools: input.tools ?? [] },
    goals: { enabled: input.goals ?? false },
    tasks: { background: input.background ?? false },
    delegation: { enabled_agents: input.delegation ?? [] },
    custom_params: {
      type: input.defaultEntry ? "orchestrator" : "general",
      behavior: {
        system_prompt: input.prompt,
        compression_trigger_ratio: 0.85,
        summarize_max_tokens: 300,
        preserve_recent_turns: 3,
        builder_template_version: AGENT_BUILDER_TEAM_TEMPLATE_VERSION,
      },
    },
  };
}
