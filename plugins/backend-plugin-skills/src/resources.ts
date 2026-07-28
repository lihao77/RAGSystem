import path from "node:path";

import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/backend-plugin.js";

export const SKILL_SOURCE_RESOURCE_KIND = "ragsystem.skill-source";

export function resolveBuiltinSkillSources(
  resources: readonly BackendPluginResourceContribution[],
): Array<{ root: string; sourceLabel: string }> {
  const roots = new Set<string>();
  const sources: Array<{ root: string; sourceLabel: string }> = [];
  for (const resource of resources) {
    if (resource.kind !== SKILL_SOURCE_RESOURCE_KIND) continue;
    if (typeof resource.value !== "string" || !path.isAbsolute(resource.value)) {
      throw new Error(`Skill source from '${resource.pluginId}' must be an absolute path`);
    }
    const root = path.normalize(resource.value);
    if (roots.has(root)) throw new Error(`Skill source is already registered: ${root}`);
    roots.add(root);
    sources.push({ root, sourceLabel: resource.pluginId });
  }
  return sources;
}
