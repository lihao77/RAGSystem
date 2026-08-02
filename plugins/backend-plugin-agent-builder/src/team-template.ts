import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { AgentConfigService } from "@ragsystem/backend-core/services/agent/config/index.js";

/** Reserved tenant Team installed by the Agent Builder plugin. */
export const AGENT_BUILDER_TEAM_NAME = "agent-builder";
export const AGENT_BUILDER_TEAM_TEMPLATE_VERSION = 1;

/**
 * Seed the managed Team once per tenant. Existing user changes are preserved;
 * template migrations must be explicit instead of overwriting a live Team.
 */
export async function ensureAgentBuilderTeam(agentConfig: AgentConfigService): Promise<boolean> {
  const summary = await agentConfig.listTeams();
  if (summary.teams.some((team) => team.team_name === AGENT_BUILDER_TEAM_NAME)) return false;
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
        "preview_data_structure",
        "glob",
        "grep",
        "web_fetch",
        "todo_write",
        "list_agent_drafts",
        "get_agent_draft",
        "create_agent_draft",
        "update_agent_draft",
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
        "Use the Agent Builder tools to create or update one Draft and keep its revision current.",
        "Never publish a Release yourself; stop at a validated candidate and explain what an administrator must approve.",
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
