import { hydrateSkillAuthoring } from "./skill-authoring-hydration.js";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { AgentConfigPort } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

/** Reserved tenant Team installed by the Agent Builder plugin. */
export const AGENT_BUILDER_TEAM_NAME = "agent-builder";
export const AGENT_BUILDER_TEAM_TEMPLATE_VERSION = 17;

const CAPABILITY_INVENTORY_TOOL = "list_agent_builder_capabilities";
const CAPABILITY_DETAIL_TOOL = "get_capability_detail";

const SKILL_AUTHORING_TOOLS = [
  "list_skills",
  "get_skill",
  "create_skill",
  "save_skill",
] as const;

const CAPABILITY_DISCOVERY_MARKER = "Capability discovery protocol:";
const CAPABILITY_DISCOVERY_PROMPT = [
  CAPABILITY_DISCOVERY_MARKER,
  "before creating or updating a Draft, call list_agent_builder_capabilities. Its platform_tools section lists the platform-native Tools and is the ONLY source of names allowed in an Agent's tools whitelist; its capability_providers sections (MCP servers, Skills, and any other registered provider) are bound via agents[].capabilities keyed by provider id—binding them injects their tools automatically at runtime, so never write provider tools into the tools whitelist, and never invent names.",
  "The inventory lists names and short metadata only; before binding an MCP server, or any capability whose behavior you cannot infer from its name, call get_capability_detail to see what it actually provides (for MCP servers: the live tool inventory with read-only flags).",
].join(" ");
const LEGACY_CAPABILITY_DISCOVERY_SENTENCE = "Before creating or updating a Draft, call list_agent_builder_capabilities and bind only the returned Tool, Skill, and MCP Server names. Never invent capability names.";

const DRAFT_WORKFLOW_PROMPT = "Use list_agent_drafts, with a query when needed, to find a Draft (summaries by default; pass include_blueprint=true or use get_agent_draft for the full blueprint). Use get or create to open a workspace Draft; blueprint.schema.md in the workspace documents every field, enum, and the manifest revision lock. Edit blueprint.json with file tools and call validate_agent_draft to check it at any time; publish validates, synchronizes, and auto-publishes when enabled.";

const LEGACY_DRAFT_WORKFLOW_SENTENCE = "Use list_agent_drafts, with a query when needed, to find a Draft; use get to copy it into the current Session workspace, or create to start a new workspace Draft. Edit blueprint.json with file tools, then call publish; publish performs validation and synchronization automatically.";

const DELEGATION_ARTIFACTS_PROMPT = "When delegating research or review, pass input file paths through the agent tool's artifacts parameter instead of pasting file contents into the message; the receiving Agent reads them with file tools.";

const TEAM_DESIGN_NORMS_MARKER = "Team design norms:";
const TEAM_DESIGN_NORMS_PROMPT = [
  TEAM_DESIGN_NORMS_MARKER,
  "the entry Agent talks to the user directly, so it must be the most capable generalist in the Team it designs: bind it enough tools and capabilities to resolve routine requests end-to-end on its own (typically a superset of its sub-agents' tools) and write in its instructions that it solves tasks directly first.",
  "Delegate only what genuinely benefits from a sub-agent: parallelizable independent subtasks, context-heavy exploration that would flood the main conversation, deep specialized sub-processes, and isolated verification.",
  "The entry Agent handles everything else itself: quick answers, anything within a few tool calls, and synthesis that needs the full conversation context.",
  "Never design a router-only entry Agent that forwards every request to sub-agents; it adds a delegation hop to each turn and leaves the Team unable to serve the user when the sub-agent fails.",
].join(" ");

const DOMAIN_EXPLORATION_MARKER = "Domain exploration protocol:";
const DOMAIN_EXPLORATION_PROMPT = [
  DOMAIN_EXPLORATION_MARKER,
  "a built Team is worth publishing only if it knows things a general Team does not. Before designing, ask the user for real sample requests, domain documents, knowledge-base material, or access to the systems involved.",
  "Run representative samples end-to-end with the capabilities this runtime already has, and record where you get stuck, what information is missing, and which manual steps repeat; those findings are the Team's domain priors.",
  "If no samples or materials can be obtained, say so explicitly and design conservatively; never invent domain facts to fill the gap.",
].join(" ");

const EXPERIENCE_LAYERING_MARKER = "Experience layering:";
const EXPERIENCE_LAYERING_PROMPT = [
  EXPERIENCE_LAYERING_MARKER,
  "put volatile behavior and role direction into agent instructions and rewrite them as a whole instead of appending; put stable domain knowledge (glossaries, process rules, data formats, system procedures) into Skills so other Teams can reuse it; put every failure you fixed into a blueprint acceptance case so it becomes a regression guard.",
  "Acceptance cases must come from the real samples explored or from failures you actually observed, never be invented, and are written to blueprint.json's acceptance field (source: sample or regression).",
].join(" ");

const TRIAL_PROTOCOL_MARKER = "Trial protocol:";
const TRIAL_PROTOCOL_PROMPT = [
  TRIAL_PROTOCOL_MARKER,
  "before publishing, call try_agent_draft with the blueprint's acceptance samples (or user-provided inputs) to run the draft end-to-end on a throwaway staging Team.",
  "Read the report as a designer, not an inspector: a wrong or missing answer is design input for improving instructions, tools, or delegation; a suspended run means the Team asks the user for clarification, which may itself be correct behavior.",
  "The trial is evidence, not a gate—you may still publish with an imperfect report after explaining the remaining risk to the user.",
  "Each input is a real model call: batch at most five inputs per try, and reuse earlier observations instead of re-running unchanged samples after small edits.",
].join(" ");

const FAILURE_FEEDBACK_MARKER = "Failure feedback protocol:";
const FAILURE_FEEDBACK_PROMPT = [
  FAILURE_FEEDBACK_MARKER,
  "when the user asks to improve or rebuild a Team whose domain already has a live published Team, call collect_team_failures for that Team first: it aggregates thumbs-down feedback into an evidence file (user input, disliked answer, run status, delegation shape) under .ragsystem/agent-builder/evidence/.",
  "Treat failure samples as prior knowledge at the same level as domain exploration: reproduce the failing inputs as acceptance cases (source: regression), and fold pattern-level lessons (router-only entry, answers missing key facts, over-delegation) into the corresponding agent instructions.",
  "A sample flagged entry_router_only means the entry agent delegated while producing almost no content of its own—redesign its responsibilities per the team design norms.",
  "No samples is a valid result: do not invent lessons, design from domain exploration alone.",
].join(" ");
/** v17：编排者自试用工具——设计前用真实执行验证假设，而不是凭空出蓝图。 */
const PROTOTYPING_TOOLS = [
  "execute_code",
  "execute_shell",
  "view_image",
] as const;

const PROTOTYPING_PROTOCOL_MARKER = "Prototyping protocol:";
const PROTOTYPING_PROTOCOL_PROMPT = [
  PROTOTYPING_PROTOCOL_MARKER,
  "before committing a design to the blueprint, verify uncertain assumptions yourself: use execute_code and execute_shell in the Session workspace to run representative samples against real data, reproduce failing inputs, and check data formats, commands, and tool behavior; use view_image to inspect images the user provides as domain material.",
  "First-hand evidence from these runs is domain exploration: record what actually worked and what failed, and let it drive the design instead of speculation.",
  "Respect the platform's boundaries: execution is for exploration inside the Session workspace, never for bypassing Tool risk controls, publishing drafts, or changing runtime files.",
].join(" ");
const LEGACY_SKILL_AUTHORING_PROMPT = `Use list_skill_drafts, with a query when needed, to find reusable Skill drafts. Use get_skill_draft to copy a draft into the current Session workspace, or create_skill_draft to create one from scratch. Edit SKILL.md and its resources with file tools, then call publish_skill_draft. Publishing validates the local bundle; on failure, fix the files and retry. Do not call separate validate or approve tools. A Skill is not available to Agents until publication succeeds.`;
const SKILL_AUTHORING_PROMPT_MARKER = "Skill authoring runtime contract:";
const SKILL_AUTHORING_PROMPT = [
  "Use list_skills, with a query when needed, to find reusable Skills. Use get_skill with name to open a Skill in the current Session workspace, or create_skill with name and description to prepare a new Skill.",
  SKILL_AUTHORING_PROMPT_MARKER,
  "Skill direct-save workflow: only tenant administrators may create or save Skills. Temporary files stay in the Session workspace until save_skill succeeds. Pass the returned workspace_path to save_skill; do not change manifest.json or its revision.",
  "Create a root SKILL.md whose YAML frontmatter contains name and description. Use a lower-case hyphenated name no longer than 64 characters. Do not invent frontmatter fields such as version, invocation, entrypoint, compatibility, or script manifests. Use nested metadata only when declaring actual ragsystem_requires_tools or ragsystem_requires_mcp_servers dependencies returned by list_agent_builder_capabilities.",
  "Keep SKILL.md concise and imperative. Put detailed documentation in references/, output templates or static files in assets/, and executable utilities in scripts/ only when they provide repeated deterministic behavior. Scripts are optional; do not create one for a workflow that can be expressed reliably as instructions or existing Tools.",
  "Skill activation-only workflow: activate_skill returns main_content and an absolute skill_root. Read supporting files with read_file and discover them with glob/grep. Bind these general tools, and execute_shell when scripts are needed, to consuming Agents explicitly.",
  "Keep optional scripts lightweight and non-interactive. Run them with execute_shell using an available local interpreter and the script path under skill_root; quote paths and arguments for the host shell. Use the task workspace as cwd for inputs and outputs. Skills do not install dependencies, create virtual environments, or prepare execution snapshots. Use existing MCP capabilities for functionality requiring a separately maintained environment.",
  "Saving validates the complete bundle but does not execute scripts. Test workspace scripts with the ordinary execution tools when needed, and never claim a script was tested without execution evidence.",
  "Edit SKILL.md and its resources with file tools, then call save_skill. On failure, fix the local files and retry. Do not call separate validate or approve tools. A Skill becomes available to Agents when saving succeeds.",
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
    const hydrated = hydrateSkillAuthoring(migrated ?? current, SKILL_AUTHORING_PROMPT, current);
    if (!migrated && !hydrated) return false;
    await agentConfig.applyTeamPayload(AGENT_BUILDER_TEAM_NAME, hydrated ?? migrated!);
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
        ...PROTOTYPING_TOOLS,
        CAPABILITY_INVENTORY_TOOL,
        CAPABILITY_DETAIL_TOOL,
        "list_agent_drafts",
        "get_agent_draft",
        "create_agent_draft",
        "validate_agent_draft",
        "try_agent_draft",
        "collect_team_failures",
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
        TEAM_DESIGN_NORMS_PROMPT,
        DOMAIN_EXPLORATION_PROMPT,
        PROTOTYPING_PROTOCOL_PROMPT,
        EXPERIENCE_LAYERING_PROMPT,
        TRIAL_PROTOCOL_PROMPT,
        FAILURE_FEEDBACK_PROMPT,
        CAPABILITY_DISCOVERY_PROMPT,
        DRAFT_WORKFLOW_PROMPT,
        DELEGATION_ARTIFACTS_PROMPT,
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
      prompt: "Investigate the user's requested workflow. Collect real sample requests and domain materials (documents, knowledge-base entries, MCP system access) as mandatory build input—a Team designed from hypotheticals alone has no advantage over the general Team. Return a concise requirements brief with actors, triggers, inputs, outputs, constraints, failure cases, measurable acceptance criteria, and the collected samples. Do not create or publish configuration.",
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
      prompt: "Design a complete Agent Blueprint from the research briefs and the domain-exploration findings. Keep the delegation graph acyclic, assign one clear entry Agent, and bind only known capabilities. The entry Agent talks to the user directly, so make it the most capable generalist in the Team: bind it enough tools to resolve routine requests itself (typically a superset of its sub-agents' tools) and delegate only parallelizable, context-heavy, or deeply specialized work. Never propose a router-only entry Agent that forwards every request without doing any work itself. Layer the exploration findings: volatile behavior into instructions, stable domain knowledge into Skills, real samples into blueprint acceptance cases. Return structured recommendations to the Orchestrator.",
    }),
    agent_evaluator: builderAgent({
      name: "agent_evaluator",
      displayName: "Agent Evaluator",
      description: "Reviews a candidate Blueprint against acceptance criteria, safety constraints, and runtime feasibility.",
      tools: ["read_file", "preview_data_structure", "glob", "grep"],
      prompt: "Evaluate the current candidate Blueprint against its acceptance criteria, runtime constraints, and any try_agent_draft observations. Identify concrete failures, missing coverage, unsafe permissions, and unnecessary complexity. Flag a router-only entry Agent that delegates everything but holds no tools or capabilities of its own, and delegation topologies that add a hop to every routine turn; the entry Agent must be able to serve the user directly. Check that blueprint acceptance cases trace to real explored samples or observed failures rather than inventions, that instructions are distilled instead of bloated, and that stable knowledge is proposed as a Skill rather than inlined into prompts. Return actionable changes; do not publish.",
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
  const prompt = typeof behavior.system_prompt === "string" ? behavior.system_prompt.trim() : "";
  const hasLegacyArtifactPrompt = [
    "kind=skill Artifact",
    "submit_skill_artifact",
    "create_skill_artifact",
    "RAGSYSTEM_ARTIFACT_OUTPUT_DIR",
    "[artifact:artifact_id]",
  ].some((marker) => prompt.includes(marker));
  // 早退必须形态驱动：版本号只记录历史，不作为「形态已齐」的证据——开发期热重载可能
  // 在版本号已 bump、marker/工具尚未写入的中间态执行过半成品迁移并落下版本戳，
  // 只看版本号会让缺失的形态永远补不上。所有协议 marker 与必备工具齐备才允许跳过。
  const existingTools = Array.isArray(orchestrator.tools?.enabled_tools)
    ? orchestrator.tools.enabled_tools
    : [];
  const wiringComplete = [
    TEAM_DESIGN_NORMS_MARKER,
    DOMAIN_EXPLORATION_MARKER,
    EXPERIENCE_LAYERING_MARKER,
    TRIAL_PROTOCOL_MARKER,
    FAILURE_FEEDBACK_MARKER,
    CAPABILITY_DISCOVERY_MARKER,
    PROTOTYPING_PROTOCOL_MARKER,
  ].every((marker) => prompt.includes(marker))
    && existingTools.includes("try_agent_draft")
    && existingTools.includes("collect_team_failures")
    && existingTools.includes(CAPABILITY_INVENTORY_TOOL)
    && existingTools.includes(CAPABILITY_DETAIL_TOOL)
    && PROTOTYPING_TOOLS.every((tool) => existingTools.includes(tool));
  if (version === null || (version >= AGENT_BUILDER_TEAM_TEMPLATE_VERSION && wiringComplete && !hasLegacyArtifactPrompt)) return null;
  const deprecatedSkillTools = new Set([
    "update_skill_draft",
    "update_agent_draft",
    "search_skill_drafts",
    "search_agent_drafts",
    "submit_skill_artifact",
    "create_skill_artifact",
  ]);
  const enabledTools = existingTools.filter((tool) => !deprecatedSkillTools.has(tool));
  if (!enabledTools.includes(CAPABILITY_INVENTORY_TOOL)) enabledTools.push(CAPABILITY_INVENTORY_TOOL);
  // v16：能力下钻工具（MCP 服务器实时工具清单等，绑定前理解能力的入口）。
  if (!enabledTools.includes(CAPABILITY_DETAIL_TOOL)) enabledTools.push(CAPABILITY_DETAIL_TOOL);
  for (const tool of ["read_file", "write_file", "edit_file"] as const) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  for (const tool of ["list_skills", "get_skill", "create_skill", "save_skill"] as const) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  for (const tool of ["list_agent_drafts", "get_agent_draft", "create_agent_draft", "validate_agent_draft", "publish_agent_draft"] as const) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  // v14：试运行工具（无头跑通验收样本，观察报告供自检自改）。
  if (!enabledTools.includes("try_agent_draft")) enabledTools.push("try_agent_draft");
  // v15：失败回流工具（聚合 👎 反馈为设计证据）。
  if (!enabledTools.includes("collect_team_failures")) enabledTools.push("collect_team_failures");
  // v17：原型验证工具——编排者设计前先用真实执行跑通假设（域探索协议的执行手段）。
  for (const tool of PROTOTYPING_TOOLS) {
    if (!enabledTools.includes(tool)) enabledTools.push(tool);
  }
  const promptBase = hasLegacyArtifactPrompt ? stripLegacySkillAuthoringPrompt(prompt) : prompt;
  // v16：能力发现协议升级——清单之外增加下钻说明；旧句子原位替换，未携带则补挂。
  const withCapabilityDiscovery = promptBase.includes(CAPABILITY_DISCOVERY_MARKER)
    ? promptBase
    : promptBase.includes(LEGACY_CAPABILITY_DISCOVERY_SENTENCE)
      ? promptBase.replace(LEGACY_CAPABILITY_DISCOVERY_SENTENCE, CAPABILITY_DISCOVERY_PROMPT)
      : `${promptBase} ${CAPABILITY_DISCOVERY_PROMPT}`.trim();
  // v11：草稿工作流升级为摘要清单 + schema 指南 + 随时校验，并补充委派 artifacts 用法。
  let workflowPrompt = withCapabilityDiscovery;
  if (!workflowPrompt.includes("validate_agent_draft")) {
    workflowPrompt = workflowPrompt.includes(LEGACY_DRAFT_WORKFLOW_SENTENCE)
      ? workflowPrompt.replace(LEGACY_DRAFT_WORKFLOW_SENTENCE, DRAFT_WORKFLOW_PROMPT)
      : `${workflowPrompt} ${DRAFT_WORKFLOW_PROMPT}`.trim();
  }
  if (!workflowPrompt.includes("artifacts parameter")) {
    workflowPrompt = `${workflowPrompt} ${DELEGATION_ARTIFACTS_PROMPT}`.trim();
  }
  // v12：团队设计规范——入口 Agent 必须自身能干活，委派只用于真正受益的子任务。
  if (!workflowPrompt.includes(TEAM_DESIGN_NORMS_MARKER)) {
    workflowPrompt = `${workflowPrompt} ${TEAM_DESIGN_NORMS_PROMPT}`.trim();
  }
  // v13：域探索协议 + 经验分层——先验来自实证探索，经验按 instructions / Skill / 验收用例三层沉淀。
  if (!workflowPrompt.includes(DOMAIN_EXPLORATION_MARKER)) {
    workflowPrompt = `${workflowPrompt} ${DOMAIN_EXPLORATION_PROMPT}`.trim();
  }
  if (!workflowPrompt.includes(EXPERIENCE_LAYERING_MARKER)) {
    workflowPrompt = `${workflowPrompt} ${EXPERIENCE_LAYERING_PROMPT}`.trim();
  }
  // v14：发布前试用协议——报告是设计证据而非门禁。
  if (!workflowPrompt.includes(TRIAL_PROTOCOL_MARKER)) {
    workflowPrompt = `${workflowPrompt} ${TRIAL_PROTOCOL_PROMPT}`.trim();
  }
  // v15：失败回流协议——👎 证据与域探索同级作为先验。
  if (!workflowPrompt.includes(FAILURE_FEEDBACK_MARKER)) {
    workflowPrompt = `${workflowPrompt} ${FAILURE_FEEDBACK_PROMPT}`.trim();
  }
  // v17：原型验证协议——设计前先自己动手验证关键假设，证据回流设计。
  if (!workflowPrompt.includes(PROTOTYPING_PROTOCOL_MARKER)) {
    workflowPrompt = `${workflowPrompt} ${PROTOTYPING_PROTOCOL_PROMPT}`.trim();
  }
  const nextPrompt = hasLegacyArtifactPrompt
    ? `${workflowPrompt} ${SKILL_AUTHORING_PROMPT}`.trim()
    : workflowPrompt.includes(SKILL_AUTHORING_PROMPT_MARKER)
      ? workflowPrompt
      : workflowPrompt.includes(LEGACY_SKILL_AUTHORING_PROMPT)
        ? workflowPrompt.replace(LEGACY_SKILL_AUTHORING_PROMPT, SKILL_AUTHORING_PROMPT)
        : `${workflowPrompt} ${SKILL_AUTHORING_PROMPT}`.trim();
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

function stripLegacySkillAuthoringPrompt(prompt: string): string {
  const markers = [
    "When the workflow contains reusable domain instructions",
    "Use list_skill_drafts or search_skill_drafts",
    "Use list_skill_drafts, with a query when needed",
  ];
  const start = markers
    .map((marker) => prompt.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return start === undefined ? prompt : prompt.slice(0, start).trim();
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
    delegation: { enabled_agents: input.delegation ?? [], parallel_children: false },
    custom_params: {
      type: input.defaultEntry ? "orchestrator" : "general",
      behavior: {
        system_prompt: input.prompt,
        compression_trigger_ratio: 0.85,
        preserve_recent_turns: 3,
        builder_template_version: AGENT_BUILDER_TEAM_TEMPLATE_VERSION,
      },
    },
  };
}
