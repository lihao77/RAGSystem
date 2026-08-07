import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { AgentConfigPort } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

/** Reserved tenant Team installed by the Agent Builder plugin. */
export const AGENT_BUILDER_TEAM_NAME = "agent-builder";
export const AGENT_BUILDER_TEAM_TEMPLATE_VERSION = 8;

const CAPABILITY_INVENTORY_TOOL = "list_agent_builder_capabilities";

const SKILL_AUTHORING_TOOLS = [
  "list_skill_drafts",
  "get_skill_draft",
  "create_skill_draft",
  "publish_skill_draft",
] as const;

const CAPABILITY_DISCOVERY_PROMPT = "Before creating or updating a Draft, call list_agent_builder_capabilities and bind only the returned Tool, Skill, and MCP Server names. Never invent capability names.";
const LEGACY_SKILL_AUTHORING_PROMPT = `Use list_skill_drafts, with a query when needed, to find reusable Skill drafts. Use get_skill_draft to copy a draft into the current Session workspace, or create_skill_draft to create one from scratch. Edit SKILL.md and its resources with file tools, then call publish_skill_draft. Publishing validates the local bundle; on failure, fix the files and retry. Do not call separate validate or approve tools. A Skill is not available to Agents until publication succeeds.`;
const SKILL_AUTHORING_PROMPT_MARKER = "Skill authoring runtime contract:";
const SKILL_AUTHORING_PROMPT = [
  "Use list_skill_drafts, with a query when needed, to find reusable Skill drafts. Use get_skill_draft to copy a draft into the current Session workspace, or create_skill_draft to create one from scratch.",
  SKILL_AUTHORING_PROMPT_MARKER,
  "Create a root SKILL.md whose YAML frontmatter contains name and description. Use a lower-case hyphenated name no longer than 64 characters. Do not invent frontmatter fields such as version, invocation, entrypoint, compatibility, or script manifests. Use nested metadata only when declaring actual ragsystem_requires_tools or ragsystem_requires_mcp_servers dependencies returned by list_agent_builder_capabilities.",
  "Keep SKILL.md concise and imperative. Put detailed documentation in references/, output templates or static files in assets/, and executable utilities in scripts/ only when they provide repeated deterministic behavior. Scripts are optional; do not create one for a workflow that can be expressed reliably as instructions or existing Tools.",
  "The current Skill runtime executes Python only. Put executable scripts under scripts/ with a .py extension, and declare third-party Python packages in a root requirements.txt. Do not generate Bash, PowerShell, batch, Node.js, TypeScript, notebook, executable binaries, or shell-wrapper scripts.",
  "Design each Python script as a non-interactive argv CLI. Use separate argv tokens, resolve user inputs from arguments or the Session workspace, never hard-code machine-specific absolute paths, write normal results as UTF-8 JSON to stdout, write diagnostics to stderr, and return a nonzero exit code on failure. Use RAGSYSTEM_ARTIFACT_OUTPUT_DIR only when the script intentionally returns staged Artifact assets.",
  "In SKILL.md, tell consuming Agents to activate the Skill and call execute_skill_script with the published skill_name, the file name under scripts/, and an arguments array containing one argv token per item. Never instruct an Agent to run python, python3, a shell, execute_code, or a repository path directly.",
  "execute_skill_script can run only a published, visible Skill; do not call it against a Draft. The current publish action validates and synchronizes bundle structure but does not execute scripts, so never claim a script was tested unless actual execution evidence exists.",
  "Edit SKILL.md and its resources with file tools, then call publish_skill_draft. On failure, fix the local files and retry. Do not call separate validate or approve tools. A Skill is not available to Agents until publication succeeds.",
].join(" ");

/**
 * Seed the managed Team once per tenant. Existing user changes are preserved;
 * template migrations must be explicit instead of overwriting a live Team.
 */
export async function ensureAgentBuilderTeam(agentConfig: AgentConfigPort): Promise<boolean> {
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
        "Do not bypass the publish tool or change runtime files. The platform may auto-publish validated drafts when tenant automation is enabled; report whether the draft remained pending or was published to its Team, and never auto-activate a Team.",
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
      prompt: "Design a complete Agent Blueprint from the research briefs. Keep the delegation graph acyclic, assign one clear entry Agent, and bind only known capabilities. Return structured recommendations to the Orchestrator.",
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
      prompt: "Use evaluation findings to propose the smallest high-impact Blueprint revision. Preserve working behavior and avoid speculative new Tools. Return a patch plan to the Orchestrator.",
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
  const deprecatedSkillTools = new Set(["update_skill_draft", "update_agent_draft", "search_skill_drafts", "search_agent_drafts"]);
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
  const withCapabilityDiscovery = prompt.includes("list_agent_builder_capabilities")
    ? prompt
    : `${prompt} ${CAPABILITY_DISCOVERY_PROMPT}`.trim();
  const nextPrompt = withCapabilityDiscovery.includes(SKILL_AUTHORING_PROMPT_MARKER)
    ? withCapabilityDiscovery
    : withCapabilityDiscovery.includes(LEGACY_SKILL_AUTHORING_PROMPT)
      ? withCapabilityDiscovery.replace(LEGACY_SKILL_AUTHORING_PROMPT, SKILL_AUTHORING_PROMPT)
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
