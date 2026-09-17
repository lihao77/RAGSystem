import { z } from "zod";
import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { SkillNameSchema } from "../contracts/skills/skill-bundle.js";
import type { SkillAuthoringService } from "../services/skill-authoring-service.js";

export const SKILL_AUTHORING_TOOL_DESCRIPTORS: readonly BackendToolDescriptor[] = [
  { name: "list_skills", retired_names: ["list_skill_drafts"], description: "List available Skills", category: "skill_authoring", risk_level: "low" },
  { name: "get_skill", retired_names: ["get_skill_draft"], description: "Open a Skill in the session workspace", category: "skill_authoring", risk_level: "low" },
  { name: "create_skill", retired_names: ["create_skill_draft"], description: "Prepare a new Skill in the session workspace", category: "skill_authoring", risk_level: "low" },
  { name: "save_skill", retired_names: ["publish_skill_draft"], description: "Validate and save a complete Skill; it becomes available immediately", category: "skill_authoring", risk_level: "low" },
];

export function createSkillAuthoringTools(input: {
  authoring: SkillAuthoringService;
  authorize: (context: ToolExecContext) => Promise<void>;
}): Tool[] {
  const definitions = [
    { name: "list_skills", schema: z.object({ query: z.string().max(200).optional() }).strict(),
      properties: { query: { type: "string" } }, required: [],
      action: async (args: Record<string, unknown>) => input.authoring.listSkills(String(args.query ?? "")) },
    { name: "get_skill", schema: z.object({ name: SkillNameSchema }).strict(),
      properties: { name: { type: "string" } }, required: ["name"],
      action: async (args: Record<string, unknown>, context: ToolExecContext) => input.authoring.openWorkspace(String(args.name), workspaceRoot(context)) },
    { name: "create_skill", schema: z.object({ name: SkillNameSchema, description: z.string().trim().min(1).max(1000) }).strict(),
      properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"],
      action: async (args: Record<string, unknown>, context: ToolExecContext) => input.authoring.openWorkspace(String(args.name), workspaceRoot(context), String(args.description)) },
    { name: "save_skill", schema: z.object({ workspace_path: z.string().min(1).max(512) }).strict(),
      properties: { workspace_path: { type: "string", description: "Session-relative workspace_path returned by get_skill/create_skill" } }, required: ["workspace_path"],
      action: async (args: Record<string, unknown>, context: ToolExecContext) => input.authoring.saveWorkspace(String(args.workspace_path), workspaceRoot(context)) },
  ];
  return definitions.map((definition) => buildTool<Record<string, unknown>>({
    name: definition.name,
    description: SKILL_AUTHORING_TOOL_DESCRIPTORS.find((item) => item.name === definition.name)!.description,
    inputSchema: definition.schema,
    parameters: { type: "object", additionalProperties: false, properties: definition.properties, required: definition.required },
    source: "agent_tool", category: "skill_authoring", riskLevel: "low",
    isReadOnly: () => definition.name === "list_skills",
    isConcurrencySafe: () => definition.name === "list_skills",
    async call(args, context) {
      try {
        await input.authorize(context);
        return toolSuccess(await definition.action(args, context), { toolName: definition.name, summary: definition.name === "save_skill" ? "Skill 已保存并生效，可通过 capabilities.skills 绑定" : "Skill workspace ready", outputType: "json" });
      } catch (error) { return toolError(definition.name, error instanceof Error ? error.message : String(error)); }
    },
  }));
}

function workspaceRoot(context: ToolExecContext): string {
  const root = context.executionPaths?.workspace ?? context.workspaceRoot;
  if (!root?.trim()) throw new Error("Current Agent Session has no workspace");
  return root;
}
