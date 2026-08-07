import path from "node:path";

import {
  createBackendResourceToken,
  type BackendPluginResourceContribution,
} from "@ragsystem/backend-core/plugins/resource-registry.js";

export const SKILL_SOURCE_RESOURCE = createBackendResourceToken<string>(
  "ragsystem.skill-source",
  "@ragsystem/backend-plugin-skills",
);
export const SKILL_SOURCE_RESOURCE_KIND = SKILL_SOURCE_RESOURCE;
export function resolveBuiltinSkillSources(
  resources: readonly BackendPluginResourceContribution[],
): Array<{ root: string; sourceLabel: string }> {
  const roots = new Set<string>();
  const sources: Array<{ root: string; sourceLabel: string }> = [];
  for (const resource of resources) {
    if (resource.token.id !== SKILL_SOURCE_RESOURCE.id) continue;
    if (typeof resource.value !== "string" || !path.isAbsolute(resource.value)) {
      throw new Error(`Skill source from '${resource.providerId}' must be an absolute path`);
    }
    const root = path.normalize(resource.value);
    if (roots.has(root)) throw new Error(`Skill source is already registered: ${root}`);
    roots.add(root);
    sources.push({ root, sourceLabel: resource.providerId });
  }
  return sources;
}
