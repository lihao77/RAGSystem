import { buildTool, type Tool } from "@ragsystem/agent-sdk";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { toolError, toolSuccess } from "@ragsystem/backend-core/services/agent/sdk/tool-results.js";
import { z } from "zod";

export const CREATE_SKILL_ARTIFACT_TOOL_NAME = "create_skill_artifact";

export const CREATE_SKILL_ARTIFACT_TOOL_DESCRIPTOR: BackendToolDescriptor = {
  name: CREATE_SKILL_ARTIFACT_TOOL_NAME,
  description: "Create a complete kind=skill Artifact in the current Session",
  category: "artifact",
  risk_level: "low",
};

const SkillNameSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const SkillFileSchema = z.object({
  path: z.string().trim().min(1).max(512),
  media_type: z.string().trim().min(1).max(200).optional(),
  content: z.string().optional(),
  data_base64: z.string().optional(),
}).strict().superRefine((file, context) => {
  if (Number(file.content !== undefined) + Number(file.data_base64 !== undefined) !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Each file must provide exactly one of content or data_base64",
    });
  }
});

const CreateSkillArtifactSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(1_000),
  content: z.string().trim().min(1).max(30_000),
  metadata: z.record(z.unknown()).optional(),
  files: z.array(SkillFileSchema).max(255).optional(),
}).strict();

const CREATE_SKILL_ARTIFACT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "content"],
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9][a-z0-9-]*$",
      description: "Canonical Skill name using lower-case letters, digits, and hyphens.",
    },
    description: { type: "string", minLength: 1, maxLength: 1_000 },
    content: { type: "string", minLength: 1, maxLength: 30_000, description: "SKILL.md body without frontmatter." },
    metadata: { type: "object", additionalProperties: true },
    files: {
      type: "array",
      maxItems: 255,
      description: "Optional scripts and resources. SKILL.md is generated automatically and must not be included.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 512 },
          media_type: { type: "string", minLength: 1, maxLength: 200 },
          content: { type: "string", description: "UTF-8 text content. Mutually exclusive with data_base64." },
          data_base64: { type: "string", description: "Base64 binary content. Mutually exclusive with content." },
        },
      },
    },
  },
} as const;

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

interface SkillBundleFile {
  path: string;
  mediaType: string;
  body: Buffer;
}

export function createSkillArtifactTools(agent: { tools: { enabled_tools: string[] } }): Tool[] {
  if (!agent.tools.enabled_tools.includes(CREATE_SKILL_ARTIFACT_TOOL_NAME)) return [];
  return [buildTool({
    name: CREATE_SKILL_ARTIFACT_TOOL_NAME,
    description: "Create and persist a complete Skill bundle as a kind=skill Artifact in the current Session. SKILL.md is generated from name, description, content, and metadata. This does not submit, publish, or bind the Skill.",
    inputSchema: CreateSkillArtifactSchema,
    parameters: CREATE_SKILL_ARTIFACT_PARAMETERS,
    source: "agent_tool",
    category: "artifact",
    riskLevel: "low",
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call(args) {
      try {
        const assets = buildAssets(args);
        const bundlePaths = Object.fromEntries(assets.map((asset) => [
          String(asset.asset_id),
          String(asset.filename),
        ]));
        return toolSuccess({
          artifact: {
            schema_version: 2,
            action: "create",
            kind: "skill",
            subtype: "bundle",
            title: args.name,
            status: "ready",
            assets,
            metadata: {
              skill_name: args.name,
              skill_description: args.description,
              skill_bundle_paths: bundlePaths,
            },
          },
        }, {
          toolName: CREATE_SKILL_ARTIFACT_TOOL_NAME,
          summary: `Skill Artifact '${args.name}' prepared for persistence`,
          outputType: "skill",
        });
      } catch (error) {
        return toolError(CREATE_SKILL_ARTIFACT_TOOL_NAME, errorMessage(error));
      }
    },
  })];
}

function buildAssets(args: z.infer<typeof CreateSkillArtifactSchema>): Array<Record<string, unknown>> {
  const files: SkillBundleFile[] = [{
    path: "SKILL.md",
    mediaType: "text/markdown",
    body: Buffer.from(serializeSkillMarkdown(args), "utf8"),
  }];
  const seen = new Set(["skill.md"]);
  for (const file of args.files ?? []) {
    const relativePath = normalizeBundlePath(file.path);
    if (!relativePath) throw new Error(`Invalid Skill file path: ${file.path}`);
    const key = relativePath.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate or reserved Skill file path: ${relativePath}`);
    seen.add(key);
    files.push({
      path: relativePath,
      mediaType: file.media_type ?? inferMediaType(relativePath),
      body: file.content !== undefined ? Buffer.from(file.content, "utf8") : decodeBase64(file.data_base64 ?? "", relativePath),
    });
  }
  let totalBytes = 0;
  return files.map((file, index) => {
    if (file.body.byteLength === 0) throw new Error(`Skill file cannot be empty: ${file.path}`);
    totalBytes += file.body.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Skill Artifact total size cannot exceed 50MB");
    return {
      asset_id: `skill-file-${index + 1}`,
      role: "file",
      filename: file.path,
      media_type: file.mediaType,
      data_base64: file.body.toString("base64"),
    };
  });
}

function serializeSkillMarkdown(input: z.infer<typeof CreateSkillArtifactSchema>): string {
  const metadata = input.metadata ?? {};
  const metadataYaml = Object.keys(metadata).length > 0
    ? `metadata:\n${Object.entries(metadata).map(([key, value]) => `  ${yamlKey(key)}: ${JSON.stringify(value)}\n`).join("")}`
    : "";
  return `---\nname: ${input.name}\ndescription: ${JSON.stringify(input.description)}\n${metadataYaml}---\n\n${input.content.replace(/^\r?\n/, "")}\n`;
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function normalizeBundlePath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  if (!normalized
    || /^[A-Za-z]:/.test(normalized)
    || normalized.includes("\0")
    || normalized.split("/").some((part) => part === ".." || part === "." || part === "")) return null;
  return normalized;
}

function decodeBase64(value: string, relativePath: string): Buffer {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`Invalid base64 content for Skill file: ${relativePath}`);
  }
  return Buffer.from(value, "base64");
}

function inferMediaType(relativePath: string): string {
  const extension = relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase();
  return ({
    json: "application/json",
    md: "text/markdown",
    py: "text/x-python",
    sh: "text/x-shellscript",
    ts: "text/typescript",
    js: "text/javascript",
    txt: "text/plain",
    yaml: "application/yaml",
    yml: "application/yaml",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
