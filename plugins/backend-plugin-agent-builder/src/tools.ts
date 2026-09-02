import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { listAgentCapabilityProviders } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";

import type { AgentDraft } from "./contracts.js";
import type { AgentBuilderService } from "./service.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import { runDraftTrial, MAX_TRIAL_INPUTS_PER_CALL, type DraftTrialInput } from "./trial.js";
import { collectTeamFailures, renderTeamFailureMarkdown } from "./failures.js";

const EmptyToolInputSchema = z.object({}).strict();
const SearchDraftToolInputSchema = z.object({
  query: z.string().trim().max(200).optional().default(""),
  include_blueprint: z.boolean().optional().default(false),
}).strict();
const CreateDraftToolInputSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  description: z.string().trim().min(1).max(1_000),
}).strict();
const DraftIdToolInputSchema = z.object({
  draft_id: z.string().trim().min(1),
}).strict();
const TryDraftToolInputSchema = z.object({
  draft_id: z.string().trim().min(1),
  inputs: z.array(z.object({
    case: z.string().trim().min(1).max(2_000),
    expect_contains: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  }).strict()).min(1).max(MAX_TRIAL_INPUTS_PER_CALL, {
    message: `inputs 一次最多 ${MAX_TRIAL_INPUTS_PER_CALL} 条（每条都是真实模型调用）；更多样本请分批调用`,
  }).optional(),
}).strict();
const CollectFailuresToolInputSchema = z.object({
  team_name: z.string().trim().min(1).max(64),
  since: z.string().trim().min(1).max(40).optional(),
  feedback_limit: z.number().int().min(1).max(200).optional(),
}).strict();
/** 内联返回的样本上限：全量样本在证据文件里，避免大报告撑爆上下文。 */
const INLINE_SAMPLE_CAP = 10;
export interface AgentBuilderToolOptions {
  autoApproveDraft?: (draft: AgentDraft) => Promise<AgentDraft>;
  bindingsProvider?: () => Promise<import("./service.js").AgentBuilderBindings>;
  /** 无头试运行依赖租户运行时容器（与 scheduler 同通道）；缺省时 try_agent_draft 不可用。 */
  registry?: RuntimeContainerRegistry | null;
  tenantId?: string | null;
}

export function createAgentBuilderTools(
  service: AgentBuilderService,
  capabilities?: CapabilityRegistry,
  options: AgentBuilderToolOptions = {},
): Tool[] {
  return [
    buildTool({
      name: "list_agent_builder_capabilities",
      description: "List the existing Tools and all registered capability providers (for example Skills and MCP Servers) available to this tenant. Each provider section lists its bindable capability names. Use this before designing a Blueprint; only bind names returned by this tool and never invent capabilities.",
      inputSchema: EmptyToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        try {
          const providers = capabilities ? listAgentCapabilityProviders(capabilities) : [];
          const capabilityProviders = await Promise.all(providers.map(async (provider) => ({
            id: provider.id,
            display_name: provider.display_name,
            ...(provider.usage_note ? { usage_note: provider.usage_note } : {}),
            items: await provider.listItems(),
          })));
          const tools = service.listAvailableTools();
          const llmProviders = service.getModelAdapterPort()?.listProviders()
            .map((provider) => ({
              name: provider.name,
              ...(provider.key ? { key: provider.key } : {}),
              provider_type: provider.provider_type,
              models: provider.models.map((model) => model.name),
            })) ?? [];
          const itemCount = capabilityProviders.reduce((sum, section) => sum + section.items.length, 0);
          return toolSuccess({
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              category: tool.category,
              risk_level: tool.risk_level,
            })),
            capability_providers: capabilityProviders,
            ...(llmProviders.length > 0 ? { llm_providers: llmProviders } : {}),
          }, {
            toolName: "list_agent_builder_capabilities",
            summary: `Found ${tools.length} Tool(s) and ${itemCount} capability item(s) across ${capabilityProviders.length} provider(s)`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("list_agent_builder_capabilities", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "list_agent_drafts",
      description: "List Agent Builder drafts in summary form (id, name, status, revision, agent count, validation state), optionally filtering by id, name, description, or agent name. Set include_blueprint=true or use get_agent_draft when the full blueprint is needed.",
      inputSchema: SearchDraftToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", maxLength: 200 },
          include_blueprint: { type: "boolean", description: "Include the complete blueprint of each draft; omitted from summaries by default." },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) {
        try {
          const drafts = await service.searchDrafts(input.query ?? "");
          const items = drafts.map((draft) => ({
            ...draftSummary(draft),
            ...(input.include_blueprint ? { blueprint: draft.blueprint } : {}),
          }));
          return toolSuccess(items, {
            toolName: "list_agent_drafts",
            summary: `${drafts.length} Agent draft(s) found`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("list_agent_drafts", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "get_agent_draft",
      description: "Copy one Agent Builder draft, including blueprint.json, into the current Session workspace for editing.",
      inputSchema: DraftIdToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: { draft_id: { type: "string", minLength: 1 } },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input, context: ToolExecContext) {
        try {
          const draft = await service.getDraft(input.draft_id);
          const workspace = workspaceRoot(context);
          const materialized = await service.materializeDraftToWorkspace(draft, workspace);
          return toolSuccess({
            ...draft,
            workspace_path: materialized.workspacePath,
            editable_files: ["manifest.json", "blueprint.json"],
          }, {
            toolName: "get_agent_draft",
            summary: `Agent draft '${draft.id}' copied to the current Session workspace`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("get_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "create_agent_draft",
      description: "Create an editable Agent draft workspace from a name and description. If a same-name Team has no Draft, restore its current configuration for continued editing. Complete blueprint.json with file tools, then publish the draft.",
      inputSchema: CreateDraftToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9_-]*$" },
          description: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input, context: ToolExecContext) {
        try {
          const bindings = options.bindingsProvider ? await options.bindingsProvider() : undefined;
          const result = await service.createWorkspaceDraft(input.name, input.description, workspaceRoot(context), bindings);
          return toolSuccess({
            ...result.draft,
            workspace_path: result.workspacePath,
            editable_files: ["manifest.json", "blueprint.json"],
          }, {
            toolName: "create_agent_draft",
            summary: `Agent draft '${result.draft.id}' created in the current Session workspace`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("create_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "validate_agent_draft",
      description: "Read the local Agent draft workspace and return the same validation report publish would enforce, without publishing. Errors block publish; warnings (missing llm_tiers, unknown llm provider, router-only entry agent, missing acceptance cases) do not. Use it freely while editing blueprint.json.",
      inputSchema: DraftIdToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: {
          draft_id: { type: "string", minLength: 1 },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input, context: ToolExecContext) {
        try {
          const bindings = options.bindingsProvider ? await options.bindingsProvider() : undefined;
          if (!bindings) throw new Error("Agent Builder bindings are unavailable");
          const report = await service.validateWorkspaceDraft(input.draft_id, workspaceRoot(context), bindings);
          return toolSuccess({
            draft_id: input.draft_id,
            ...report,
          }, {
            toolName: "validate_agent_draft",
            summary: report.valid
              ? `Agent draft '${input.draft_id}' is valid${report.issues.length ? ` (${report.issues.length} warning(s))` : ""}`
              : `Agent draft '${input.draft_id}' has ${report.issues.length} issue(s), ${report.issues.filter((item) => item.level === "error").length} blocking`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("validate_agent_draft", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "try_agent_draft",
      description: `Trial-run the current workspace draft before publishing: materialize it to a throwaway staging Team, run each input end-to-end headlessly, and return observations (the entry agent's answer, which expect_contains fragments were missing, which sub-agents were delegated to). Inputs default to the blueprint's acceptance cases (beyond ${MAX_TRIAL_INPUTS_PER_CALL} they are truncated and reported in truncated_inputs); explicitly passing more than ${MAX_TRIAL_INPUTS_PER_CALL} inputs is rejected — split into batches instead, because every input is a real model call. Two consecutive inputs failing with the identical error short-circuit the rest as skipped (a config-level error will not change with new inputs). The staging Team and trial sessions are deleted afterwards. Treat the report as design evidence, not a gate: improve the blueprint from what you observe, and reuse earlier observations instead of re-running unchanged samples.`,
      inputSchema: TryDraftToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: {
          draft_id: { type: "string", minLength: 1 },
          inputs: {
            type: "array",
            description: `Inputs to run; defaults to the blueprint acceptance cases. At most ${MAX_TRIAL_INPUTS_PER_CALL} accepted per call.`,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["case"],
              properties: {
                case: { type: "string", minLength: 1, maxLength: 2000 },
                expect_contains: { type: "array", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 20 },
              },
            },
            maxItems: MAX_TRIAL_INPUTS_PER_CALL,
          },
        },
      },
      riskLevel: "high",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input, context: ToolExecContext) {
        try {
          if (!options.registry || !options.tenantId) throw new Error("Trial execution is unavailable: runtime registry is not wired");
          const bindings = options.bindingsProvider ? await options.bindingsProvider() : undefined;
          if (!bindings) throw new Error("Agent Builder bindings are unavailable");
          const report = await runDraftTrial(
            {
              service,
              registry: options.registry,
              tenantId: options.tenantId,
              // 试用会话/run 归属发起者本人（SaaS 下 usr_local 会造成归属错位与残留不可见）
              ...(context.userId ? { userId: context.userId } : {}),
              bindings,
            },
            input.draft_id,
            workspaceRoot(context),
            input.inputs as DraftTrialInput[] | undefined,
          );
          return toolSuccess({
            draft_id: input.draft_id,
            ...report,
          }, {
            toolName: "try_agent_draft",
            summary: `Trial of draft '${input.draft_id}' on staging Team '${report.staging_team}': ${report.summary.completed}/${report.summary.total} completed${report.summary.failed ? `, ${report.summary.failed} failed` : ""}${report.summary.suspended ? `, ${report.summary.suspended} suspended` : ""}${report.summary.skipped ? `, ${report.summary.skipped} skipped` : ""}${report.summary.all_expectations_met ? "; all expectations met" : "; expectations missing"}`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("try_agent_draft", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "collect_team_failures",
      description: `Collect user-marked failure evidence for a published Team: tenant-wide thumbs-down feedback anchored to that Team's sessions, joined with the transcript around each rated answer (the user's input, the disliked answer, which agent produced it), the run status (status/terminal_reason), the team revision the session ran on, and a delegation observation derived from the run tree (children of the rated run; whether the entry agent only routed work instead of answering). The full sample set is written to an evidence file under .ragsystem/agent-builder/evidence/ in the current Session workspace; inline output carries at most 10 samples (samples_omitted points to the file). A team name not present in the tenant registry returns team_exists=false without scanning or writing any file—use the published team name, not the draft name. has_more=true means the scan limit was reached and older feedback may exist. Use it before redesigning or rebuilding a Team whose domain already has a live Team, and after users report dissatisfaction; treat samples as design input alongside domain exploration — regression inputs become acceptance cases (source: regression), pattern-level lessons go into instructions. Note: samples may contain other tenant users' feedback comments and answers (tenant-scoped by design).`,
      inputSchema: CollectFailuresToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["team_name"],
        properties: {
          team_name: { type: "string", minLength: 1, maxLength: 64 },
          since: { type: "string", description: "ISO timestamp; only feedback updated at or after it is scanned" },
          feedback_limit: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input, context: ToolExecContext) {
        try {
          if (!options.registry || !options.tenantId) throw new Error("Failure collection is unavailable: runtime registry is not wired");
          const report = await collectTeamFailures(
            { service, registry: options.registry, tenantId: options.tenantId },
            input.team_name,
            {
              ...(input.since ? { since: input.since } : {}),
              ...(input.feedback_limit ? { feedbackLimit: input.feedback_limit } : {}),
            },
          );
          if (!report.team_exists) {
            // 拼错团队名不该伪装成 0 样本，也不该留下空证据文件
            return toolSuccess(report, {
              toolName: "collect_team_failures",
              summary: `Team '${input.team_name}' not found in the tenant registry; nothing scanned and no evidence file written. Check the published team name (not the draft name).`,
              outputType: "json",
            });
          }
          // 证据落在工作区的 agent-builder 目录下，与草稿同根：Builder 用 read_file 即可回看
          const safeTeam = input.team_name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 64) || "team";
          const evidenceRelative = path.join(".ragsystem", "agent-builder", "evidence", `failures-${safeTeam}.md`);
          const evidencePath = path.join(workspaceRoot(context), evidenceRelative);
          await mkdir(path.dirname(evidencePath), { recursive: true });
          await writeFile(evidencePath, renderTeamFailureMarkdown(report), "utf8");
          // 全量样本可能很大（每条带摘录/备注），内联只带前 10 条，其余在证据文件里
          const inlineSamples = report.samples.slice(0, INLINE_SAMPLE_CAP);
          const omitted = report.samples.length - inlineSamples.length;
          return toolSuccess({
            ...report,
            samples: inlineSamples,
            ...(omitted > 0 ? { samples_omitted: omitted } : {}),
            evidence_file: evidenceRelative,
          }, {
            toolName: "collect_team_failures",
            summary: `Team '${input.team_name}': ${report.samples.length} failure sample(s) across ${report.sessions_matched} session(s) from ${report.tenant_rows_scanned} tenant thumbs-down row(s)${report.has_more ? " (scan limit reached, older feedback may exist)" : ""}${report.sessions_truncated ? ` (session cap ${report.sessions_matched} reached)` : ""}${omitted > 0 ? `; ${omitted} older sample(s) only in ${evidenceRelative}` : ""}; evidence written to ${evidenceRelative}`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("collect_team_failures", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "publish_agent_draft",
      description: "Read the local Agent draft workspace, validate its blueprint, synchronize it to the system Draft, and publish automatically when enabled. Validation failures return an error and do not change the system Draft.",
      inputSchema: DraftIdToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: {
          draft_id: { type: "string", minLength: 1 },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input, context: ToolExecContext) {
        try {
          const bindings = options.bindingsProvider
            ? await options.bindingsProvider()
            : null;
          if (!bindings) throw new Error("Agent Builder bindings are unavailable");
          const result = await service.publishWorkspaceDraft(input.draft_id, workspaceRoot(context), bindings);
          return toolSuccess({
            ...result.draft,
            auto_published: result.auto_published,
            workspace_path: result.workspacePath,
            team_name: result.draft.source_team_name,
            activation: result.auto_published
              ? "published to its Team; activate the Team from the team list to run it (never auto-activated)"
              : "awaiting administrator publication",
          }, {
            toolName: "publish_agent_draft",
            summary: result.auto_published
              ? `Agent draft '${result.draft.id}' published to Team '${result.draft.source_team_name}' (activate it from the team list to run it)`
              : `Agent draft '${result.draft.id}' synchronized and is awaiting administrator publication`,
            outputType: "json",
          });
        } catch (error) {
          return toolError("publish_agent_draft", errorMessage(error));
        }
      },
    }),
  ];
}

function workspaceRoot(context: ToolExecContext): string {
  const root = context.executionPaths?.workspace ?? context.workspaceRoot;
  if (!root?.trim()) throw new Error("Current Agent Session has no workspace");
  return root;
}

/** 草稿清单的摘要视图：不含 blueprint 全文，全文经 get_agent_draft 或 include_blueprint 获取。 */
function draftSummary(draft: AgentDraft): Record<string, unknown> {
  return {
    id: draft.id,
    name: draft.blueprint.name,
    description: draft.blueprint.description,
    status: draft.status,
    revision: draft.revision,
    source_team_name: draft.source_team_name,
    entry_agent: draft.blueprint.entry_agent,
    agent_count: draft.blueprint.agents.length,
    validation: draft.validation === null ? null : {
      valid: draft.validation.valid,
      issue_count: draft.validation.issues.length,
    },
    published_at: draft.published_at,
    updated_at: draft.updated_at,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const report = (error as { report?: unknown }).report;
    return report ? `${error.message}: ${JSON.stringify(report)}` : error.message;
  }
  return String(error);
}
