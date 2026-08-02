import { z } from "zod";

import { buildTool, type Tool } from "@ragsystem/agent-sdk";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

import { AgentBlueprintSchema } from "./contracts.js";
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

export function createAgentBuilderTools(service: AgentBuilderService): Tool[] {
  return [
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
          return toolSuccess(draft, {
            toolName: "create_agent_draft",
            summary: `Agent draft '${draft.id}' created for '${draft.blueprint.name}'`,
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
          return toolSuccess(draft, {
            toolName: "update_agent_draft",
            summary: `Agent draft '${draft.id}' updated to revision ${draft.revision}`,
            outputType: "agent_builder.draft",
          });
        } catch (error) {
          return toolError("update_agent_draft", error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];
}
