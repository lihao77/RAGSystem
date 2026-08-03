import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";

import type { SkillsAgentConfigService } from "./config.js";
import type { SkillLibraryService } from "./services/skill-library-service.js";
import type { SkillAuthoringService } from "./services/skill-authoring-service.js";
import type { SkillToolService } from "./tools/SkillExecution.js";
import type { SkillArtifactResource } from "./resources.js";

export interface SkillsRuntimeCapability {
  readonly tools: SkillToolService;
  readonly library: SkillLibraryService;
  readonly authoring: SkillAuthoringService;
  readonly agentConfig: SkillsAgentConfigService;
  readonly artifactResource: SkillArtifactResource | null;
}

export const SKILLS_RUNTIME_CAPABILITY = createCapability<SkillsRuntimeCapability>(
  "@ragsystem/backend-plugin-skills/runtime",
);
