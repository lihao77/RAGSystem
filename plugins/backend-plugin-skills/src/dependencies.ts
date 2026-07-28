import type { BackendPluginRuntimeContext } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import type { SkillsRuntimeCapability } from "./capability.js";

export interface SkillsPluginRuntime extends SkillsRuntimeCapability {
  dispose?(): void;
}

export type SkillsPluginRuntimeFactory = (
  context: BackendPluginRuntimeContext,
) => SkillsPluginRuntime | Promise<SkillsPluginRuntime>;

export interface SkillsPluginLifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface SkillsPluginDependencies {
  runtimeFactory: SkillsPluginRuntimeFactory;
  lifecycle?: SkillsPluginLifecycle;
}
