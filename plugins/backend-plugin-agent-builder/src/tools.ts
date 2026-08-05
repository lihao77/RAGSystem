import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { MCP_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-mcp/capability.js";
import { SKILLS_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-skills/capability.js";

import type { AgentDraft } from "./contracts.js";
import type { AgentBuilderService } from "./service.js";

const EmptyToolInputSchema = z.object({}).strict();
const SearchDraftToolInputSchema = z.object({ query: z.string().trim().max(200).optional().default("") }).strict();
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
      description: "List the existing Tools, Skills, and MCP Servers available to this tenant. Skill entries may include declared MCP dependencies as guidance. Use this before designing a Blueprint; only bind names returned by this tool and never invent capabilities.",
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
          const skillsRuntime = capabilities?.get(SKILLS_RUNTIME_CAPABILITY);
          const mcpRuntime = capabilities?.get(MCP_RUNTIME_CAPABILITY);
          const [skills, mcpServers] = await Promise.all([
            skillsRuntime?.library.listSkills() ?? Promise.resolve([]),
            mcpRuntime?.application.listServers() ?? Promise.resolve([]),
          ]);
          const tools = service.listAvailableTools();
          const skillInfos = skillsRuntime?.tools?.loadAllSkills?.() ?? [];
          const skillInfoByName = new Map(skillInfos.map((skill) => [skill.name, skill]));
          return toolSuccess({
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              category: tool.category,
              risk_level: tool.risk_level,
            })),
            skills: skills.map((skill) => {
              const info = skillInfoByName.get(skill.name);
              const requires = info?.requires;
              return {
                name: skill.name,
                display_name: skill.display_name,
                description: skill.description,
                ...(requires ? { requires } : {}),
              };
            }),
            mcp_servers: mcpServers.map((server) => ({
              name: server.name,
              display_name: server.display_name,
              transport: server.transport,
              enabled: server.enabled,
              status: server.status,
              tool_count: server.tool_count,
            })),
          }, {
            toolName: "list_agent_builder_capabilities",
            summary: `Found ${tools.length} Tool(s), ${skills.length} Skill(s), and ${mcpServers.length} MCP Server(s)`,
            outputType: "agent_builder.capabilities",
          });
        } catch (error) {
          return toolError("list_agent_builder_capabilities", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "list_agent_drafts",
      description: "List Agent Builder drafts, optionally filtering by id, name, description, or agent name.",
      inputSchema: SearchDraftToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string", maxLength: 200 } },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) {
        try {
          const drafts = await service.searchDrafts(input.query ?? "");
          return toolSuccess(drafts, {
            toolName: "list_agent_drafts",
            summary: `${drafts.length} Agent draft(s) found`,
            outputType: "agent_builder.drafts",
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
            outputType: "agent_builder.draft",
          });
        } catch (error) {
          return toolError("get_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "create_agent_draft",
      description: "Create an editable Agent draft workspace from a name and description. Complete blueprint.json with file tools, then publish the draft.",
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
          const result = await service.createWorkspaceDraft(input.name, input.description, workspaceRoot(context));
          return toolSuccess({
            ...result.draft,
            workspace_path: result.workspacePath,
            editable_files: ["manifest.json", "blueprint.json"],
          }, {
            toolName: "create_agent_draft",
            summary: `Agent draft '${result.draft.id}' created in the current Session workspace`,
            outputType: "agent_builder.draft",
          });
        } catch (error) {
          return toolError("create_agent_draft", error instanceof Error ? error.message : String(error));
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
            release: result.release,
            auto_published: result.auto_published,
            workspace_path: result.workspacePath,
          }, {
            toolName: "publish_agent_draft",
            summary: result.release
              ? `Agent draft '${result.draft.id}' published as release '${result.release.id}'`
              : `Agent draft '${result.draft.id}' synchronized and is awaiting administrator publication`,
            outputType: "agent_builder.draft",
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const report = (error as { report?: unknown }).report;
    return report ? `${error.message}: ${JSON.stringify(report)}` : error.message;
  }
  return String(error);
}
