import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

import {
  SkillDraftContentSchema,
  UpdateSkillDraftSchema,
} from "../contracts/skills/skill-draft.js";
import type { SkillAuthoringService } from "../services/skill-authoring-service.js";

const EmptySchema = z.object({}).strict();
const DraftIdSchema = z.object({ draft_id: z.string().trim().min(1) }).strict();

export const SKILL_AUTHORING_TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  { name: "list_skill_drafts", description: "List tenant Skill authoring drafts", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
  { name: "get_skill_draft", description: "Read one Skill authoring draft", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
  { name: "create_skill_draft", description: "Create a reviewable Skill draft", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
  { name: "update_skill_draft", description: "Update a reviewable Skill draft", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
];

const SKILL_CONTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "content"],
  properties: {
    name: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*$",
      description: "Lower-case Skill package name using letters, digits, and hyphens.",
    },
    description: {
      type: "string",
      description: "Concise statement of when this Skill should be used.",
    },
    content: {
      type: "string",
      description: "Complete SKILL.md body without YAML frontmatter. Do not include executable scripts.",
    },
  },
} as const;

export function createSkillAuthoringTools(input: {
  authoring: SkillAuthoringService;
  agentName: string;
}): Tool[] {
  return [
    buildTool({
      name: "list_skill_drafts",
      description: "List Skill drafts owned by the Skills plugin. Drafts are not available for Agent binding until an administrator publishes them.",
      inputSchema: EmptySchema,
      parameters: { type: "object", additionalProperties: false, properties: {} },
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        try {
          const drafts = await input.authoring.listDrafts();
          return toolSuccess(drafts, {
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
      description: "Read one Skill draft, including its current revision. This does not activate or bind the Skill.",
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
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(args) {
        try {
          const draft = await input.authoring.getDraft(args.draft_id);
          return toolSuccess(draft, {
            toolName: "get_skill_draft",
            summary: `Skill draft '${draft.id}' loaded at revision ${draft.revision}`,
            outputType: "skills.draft",
          });
        } catch (error) {
          return toolError("get_skill_draft", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "create_skill_draft",
      description: "Extract a reusable workflow into a reviewable Skill draft. The draft is not published and cannot be enabled on an Agent yet.",
      inputSchema: SkillDraftContentSchema,
      parameters: SKILL_CONTENT_JSON_SCHEMA,
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(args, context: ToolExecContext) {
        try {
          const draft = await input.authoring.createDraft(args, {
            sessionId: context.sessionId,
            agentName: input.agentName,
          });
          return toolSuccess(draft, {
            toolName: "create_skill_draft",
            summary: `Skill draft '${draft.id}' created for '${draft.name}'`,
            outputType: "skills.draft",
          });
        } catch (error) {
          return toolError("create_skill_draft", errorMessage(error));
        }
      },
    }),
    buildTool({
      name: "update_skill_draft",
      description: "Replace an unpublished Skill draft using optimistic revision control. This does not update an enabled Skill binding.",
      inputSchema: UpdateSkillDraftSchema.extend({ draft_id: z.string().trim().min(1) }).strict(),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["draft_id", "expected_revision", "name", "description", "content"],
        properties: {
          draft_id: { type: "string", minLength: 1 },
          expected_revision: { type: "integer", minimum: 1 },
          ...SKILL_CONTENT_JSON_SCHEMA.properties,
        },
      },
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(args) {
        try {
          const draft = await input.authoring.updateDraft(args.draft_id, args.expected_revision, {
            name: args.name,
            description: args.description,
            content: args.content,
          });
          return toolSuccess(draft, {
            toolName: "update_skill_draft",
            summary: `Skill draft '${draft.id}' updated to revision ${draft.revision}`,
            outputType: "skills.draft",
          });
        } catch (error) {
          return toolError("update_skill_draft", errorMessage(error));
        }
      },
    }),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
