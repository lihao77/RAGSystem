import type { SkillToolService } from "../../tools/skill-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
  RuntimeToolProviderVisibilityInput,
} from "../runtime-tool-types.js";
import { errorResult, readSkillToolArguments } from "../runtime-tool-bridge/arguments.js";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  EXECUTE_SKILL_SCRIPT_TOOL_NAME,
  GET_SKILL_INFO_TOOL_NAME,
  LOAD_SKILL_RESOURCE_TOOL_NAME,
  SKILL_TOOLS,
} from "../runtime-tool-bridge/registry.js";

export class SkillToolProvider implements RuntimeToolProvider {
  readonly id = "skill";

  constructor(private readonly skillTools: SkillToolService | null) {}

  listTools(input: RuntimeToolProviderVisibilityInput): RuntimeToolDefinition[] {
    if (!this.skillTools || !input.agent?.skills.auto_inject || !this.skillTools.hasVisibleSkills(input.agent)) {
      return [];
    }
    return SKILL_TOOLS.map((tool) => ({ ...tool }));
  }

  canHandle(toolName: string): boolean {
    return SKILL_TOOLS.some((tool) => tool.name === toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    const skillTools = this.skillTools;
    const toolName = call.toolName.trim();
    if (!skillTools) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    switch (toolName) {
      case ACTIVATE_SKILL_TOOL_NAME:
        return skillTools.activateSkill(readSkillToolArguments(call.arguments), context);
      case LOAD_SKILL_RESOURCE_TOOL_NAME:
        return skillTools.loadSkillResource(readSkillToolArguments(call.arguments), context);
      case GET_SKILL_INFO_TOOL_NAME:
        return skillTools.getSkillInfo(readSkillToolArguments(call.arguments), context);
      case EXECUTE_SKILL_SCRIPT_TOOL_NAME:
        return skillTools.executeSkillScript(readSkillToolArguments(call.arguments), context);
      default:
        return errorResult(`Skill provider cannot handle tool: ${toolName}`, toolName || "unknown");
    }
  }
}
