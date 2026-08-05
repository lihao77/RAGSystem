import { z } from "zod";

import { buildTool, type Tool } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import { MCP_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-mcp/capability.js";
import { SKILLS_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-skills/capability.js";

import { AgentBlueprintSchema } from "./contracts.js";
import type { AgentDraft } from "./contracts.js";
import type { AgentBuilderService } from "./service.js";

const CreateDraftToolInputSchema = z.object({
  blueprint: AgentBlueprintSchema,
}).strict();

const EmptyToolInputSchema = z.object({}).strict();
const DraftIdToolInputSchema = z.object({
  draft_id: z.string().trim().min(1),
}).strict();
const UpdateDraftToolInputSchema = z.object({
  draft_id: z.string().trim().min(1),
  expected_revision: z.number().int().positive(),
  blueprint: AgentBlueprintSchema,
}).strict();

const BLUEPRINT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "name", "description", "entry_agent", "agents"],
  properties: {
    schema_version: { type: "integer", enum: [1] },
    name: { type: "string", description: "Lower-case package identifier" },
    description: { type: "string" },
    entry_agent: { type: "string", description: "Name of the entry Agent" },
    agents: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "instructions"],
        properties: {
          name: { type: "string" },
          display_name: { type: "string" },
          description: { type: "string" },
          instructions: { type: "string" },
          llm: { type: ["object", "null"], description: "Optional Agent LLM configuration" },
          tools: { type: "array", items: { type: "string" } },
          skills: { type: "array", items: { type: "string" } },
          mcp_servers: { type: "array", items: { type: "string" } },
          delegates: { type: "array", items: { type: "string" } },
          goals_enabled: { type: "boolean" },
          background_tasks: { type: "boolean" },
        },
      },
    },
    acceptance_tests: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "input"],
        properties: {
          name: { type: "string" },
          input: { type: "string" },
          expected_contains: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export interface AgentBuilderToolOptions {
  autoApproveDraft?: (draft: AgentDraft) => Promise<AgentDraft>;
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
      description: "List the Agent Builder drafts available to the current tenant.",
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
          const drafts = await service.listDrafts();
          return toolSuccess(drafts, {
            toolName: "list_agent_drafts",
            summary: `${drafts.length} Agent draft(s) found`,
            outputType: "agent_builder.drafts",
          });
        } catch (error) {
          return toolError("list_agent_drafts", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "get_agent_draft",
      description: "Read one Agent Builder draft, including its current revision and validation report.",
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
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) {
        try {
          const draft = await service.getDraft(input.draft_id);
          return toolSuccess(draft, {
            toolName: "get_agent_draft",
            summary: `Agent draft '${draft.id}' loaded at revision ${draft.revision}`,
            outputType: "agent_builder.draft",
          });
        } catch (error) {
          return toolError("get_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "create_agent_draft",
      description: "Create a non-executable Agent draft from a complete, structured Agent blueprint. Publishing requires an administrator review through the Agent Builder API.",
      inputSchema: CreateDraftToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["blueprint"],
        properties: {
          blueprint: {
            ...BLUEPRINT_JSON_SCHEMA,
            description: "AgentBlueprint schema version 1, including package name, entry agent, capabilities, and acceptance tests.",
          },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input) {
        try {
          const draft = await service.createDraft(input.blueprint);
          const result = options.autoApproveDraft ? await options.autoApproveDraft(draft) : draft;
          return toolSuccess(result, {
            toolName: "create_agent_draft",
            summary: `Agent draft '${result.id}' created for '${result.blueprint.name}'`,
            outputType: "agent_builder.draft",
          });
        } catch (error) {
          return toolError("create_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
    buildTool({
      name: "update_agent_draft",
      description: "Update an existing, unpublished Agent draft using optimistic revision control.",
      inputSchema: UpdateDraftToolInputSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id", "expected_revision", "blueprint"],
        properties: {
          draft_id: { type: "string", minLength: 1 },
          expected_revision: { type: "integer", minimum: 1 },
          blueprint: {
            ...BLUEPRINT_JSON_SCHEMA,
            description: "Replacement AgentBlueprint schema version 1.",
          },
        },
      },
      riskLevel: "low",
      source: "agent_tool",
      category: "agent_builder",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input) {
        try {
          const draft = await service.updateDraft(input.draft_id, input.expected_revision, input.blueprint);
          const result = options.autoApproveDraft ? await options.autoApproveDraft(draft) : draft;
          return toolSuccess(result, {
            toolName: "update_agent_draft",
            summary: `Agent draft '${result.id}' updated to revision ${result.revision}`,
            outputType: "agent_builder.draft",
          });
        } catch (error) {
          return toolError("update_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
}
