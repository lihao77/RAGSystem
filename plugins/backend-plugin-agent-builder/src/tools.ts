import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { listAgentCapabilityProviders } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";

import type { AgentDraft } from "./contracts.js";
import type { AgentBuilderService } from "./service.js";

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
export interface AgentBuilderToolOptions {
  autoApproveDraft?: (draft: AgentDraft) => Promise<AgentDraft>;
  bindingsProvider?: () => Promise<import("./service.js").AgentBuilderBindings>;
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
      description: "Read the local Agent draft workspace and return the same validation report publish would enforce, without publishing. Errors block publish; warnings (missing llm_tiers, unknown llm provider) do not. Use it freely while editing blueprint.json.",
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
