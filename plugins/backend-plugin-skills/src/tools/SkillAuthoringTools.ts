import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";

import type { SkillAuthoringService } from "../services/skill-authoring-service.js";
import { toSkillDraftView, type SkillDraft } from "../contracts/skills/skill-draft.js";

const EmptySchema = z.object({}).strict();
const DraftIdSchema = z.object({ draft_id: z.string().trim().min(1) }).strict();

export const SKILL_AUTHORING_TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  { name: "list_skill_drafts", description: "List tenant Skill authoring drafts", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
  { name: "get_skill_draft", description: "Read one Skill authoring draft", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
  { name: "submit_skill_artifact", description: "Copy a session Skill Artifact into a reviewable Skill candidate", category: "skill_authoring", risk_level: "low", implemented: true, runtime_status: "implemented" },
];

const SUBMIT_ARTIFACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["artifact_id", "expected_revision"],
  properties: {
    artifact_id: { type: "string", minLength: 1, description: "The session Artifact id whose kind is skill." },
    expected_revision: { type: "integer", minimum: 1, description: "The artifact_revision returned by execute_skill_script for this Skill Artifact." },
    name: { type: "string", minLength: 1, pattern: "^[a-z0-9][a-z0-9-]*$" },
    description: { type: "string", minLength: 1 },
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
          return toolSuccess(drafts.map(candidateSummary), {
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
          return toolSuccess(toSkillDraftView(
            draft,
            draft.status === "published" ? "unknown" : "not_published",
          ), {
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
      name: "submit_skill_artifact",
      description: "Copy a complete kind=skill session Artifact, including SKILL.md, scripts, and resources, into a reviewable Skill candidate. Use the exact artifact_id and artifact_revision returned by execute_skill_script as artifact_id and expected_revision. This does not publish or bind it.",
      inputSchema: z.object({
        artifact_id: z.string().trim().min(1),
        expected_revision: z.number().int().positive(),
        name: z.string().trim().min(1).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
        description: z.string().trim().min(1).optional(),
      }).strict(),
      parameters: SUBMIT_ARTIFACT_SCHEMA,
      source: "agent_tool",
      category: "skill_authoring",
      riskLevel: "low",
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(args, context: ToolExecContext) {
        try {
          const draft = await input.authoring.submitArtifact(args.artifact_id, args.expected_revision, {
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            sourceAgentName: input.agentName,
            sourceSessionId: context.sessionId,
          });
          return toolSuccess({
            ...candidateSummary(draft),
            awaiting_review: draft.status !== "published",
          }, {
            toolName: "submit_skill_artifact",
            summary: `Skill Artifact copied to candidate '${draft.id}'`,
            outputType: "skills.candidate",
          });
        } catch (error) {
          return toolError("submit_skill_artifact", errorMessage(error));
        }
      },
    }),
  ];
}

function candidateSummary(draft: SkillDraft): Record<string, unknown> {
  return {
    draft_id: draft.id,
    candidate_id: draft.id,
    name: draft.name,
    description: draft.description,
    revision: draft.revision,
    status: draft.status,
    source_artifact_id: draft.source_artifact_id,
    source_artifact_revision: draft.source_artifact_revision,
    source_session_id: draft.source_session_id,
    bundle_asset_count: draft.bundle_assets.length,
    published_at: draft.published_at,
    updated_at: draft.updated_at,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
