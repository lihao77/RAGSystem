import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

import type { SkillAuthoringService } from "../services/skill-authoring-service.js";
import type { SkillDraft } from "../contracts/skills/skill-draft.js";

const DraftIdSchema = z.object({ draft_id: z.string().trim().min(1) }).strict();
const SearchSchema = z.object({ query: z.string().trim().max(200).optional().default("") }).strict();
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().trim().min(1).max(1_000),
}).strict();

export const SKILL_AUTHORING_TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  { name: "list_skill_drafts", description: "List Skill authoring drafts", category: "skill_authoring", risk_level: "low" },
  { name: "get_skill_draft", description: "Copy a Skill draft into the current Session workspace", category: "skill_authoring", risk_level: "low" },
  { name: "create_skill_draft", description: "Create an editable Skill draft workspace", category: "skill_authoring", risk_level: "low" },
  { name: "publish_skill_draft", description: "Validate and synchronize a local Skill draft, then publish automatically when enabled", category: "skill_authoring", risk_level: "low" },
];

export function createSkillAuthoringTools(input: {
  authoring: SkillAuthoringService;
  agentName: string;
}): Tool[] {
  return [
    buildTool({
      name: "list_skill_drafts",
      description: "List Skill drafts, optionally filtering by id, name, or description.",
      inputSchema: SearchSchema,
      parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 200 } } },
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(args) {
        try {
          const drafts = await input.authoring.searchDrafts(args.query ?? "");
          return toolSuccess(drafts.map(draftSummary), {
            toolName: "list_skill_drafts",
            summary: `${drafts.length} Skill draft(s) found`,
            outputType: "skills.drafts",
          });
        } catch (error) {
          return toolError("list_skill_drafts", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "get_skill_draft",
      description: "Copy a Skill draft, including SKILL.md and all resources, into the current Session workspace for editing.",
      inputSchema: DraftIdSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: { draft_id: { type: "string", minLength: 1 } },
      },
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(args, context: ToolExecContext) {
        try {
          const result = await input.authoring.materializeDraftToWorkspace(args.draft_id, workspaceRoot(context));
          return toolSuccess({
            ...draftSummary(result.draft),
            workspace_path: result.workspacePath,
            entry_file: "SKILL.md",
          }, {
            toolName: "get_skill_draft",
            summary: `Skill draft '${result.draft.id}' copied to the current Session workspace`,
            outputType: "skills.draft",
          });
        } catch (error) {
          return toolError("get_skill_draft", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "create_skill_draft",
      description: "Create a new editable Skill draft workspace with a scaffold SKILL.md. Edit files with Session file tools before publishing.",
      inputSchema: CreateSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9-]*$" },
          description: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(args, context: ToolExecContext) {
        try {
          const draft = await input.authoring.createDraft(args.name, args.description);
          const result = await input.authoring.materializeDraftToWorkspace(draft, workspaceRoot(context));
          return toolSuccess({
            ...draftSummary(result.draft),
            workspace_path: result.workspacePath,
            entry_file: "SKILL.md",
          }, {
            toolName: "create_skill_draft",
            summary: `Skill draft '${draft.id}' created in the current Session workspace`,
            outputType: "skills.draft",
          });
        } catch (error) {
          return toolError("create_skill_draft", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "publish_skill_draft",
      description: "Read and validate the local Skill workspace, synchronize it to the system Draft, and publish automatically when enabled. Validation failures do not change the system Draft.",
      inputSchema: DraftIdSchema,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id"],
        properties: { draft_id: { type: "string", minLength: 1 } },
      },
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(args, context: ToolExecContext) {
        try {
          const result = await input.authoring.publishWorkspaceDraft(args.draft_id, workspaceRoot(context));
          return toolSuccess({
            ...draftSummary(result.draft),
            published: result.published,
            awaiting_review: !result.published,
            workspace_path: result.workspacePath,
          }, {
            toolName: "publish_skill_draft",
            summary: result.published
              ? `Skill draft '${result.draft.id}' published successfully`
              : `Skill draft '${result.draft.id}' synchronized and is awaiting administrator publication`,
            outputType: "skills.draft",
          });
        } catch (error) {
          return toolError("publish_skill_draft", errorMessage(error));
        }
      },
    }),
  ];
}

function draftSummary(draft: SkillDraft): Record<string, unknown> {
  return {
    draft_id: draft.id,
    name: draft.name,
    description: draft.description,
    revision: draft.revision,
    status: draft.status,
    bundle_asset_count: draft.bundle_assets.length,
    published_at: draft.published_at,
    updated_at: draft.updated_at,
  };
}

function workspaceRoot(context: ToolExecContext): string {
  const root = context.executionPaths?.workspace ?? context.workspaceRoot;
  if (!root?.trim()) throw new Error("Current Agent Session has no workspace");
  return root;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
