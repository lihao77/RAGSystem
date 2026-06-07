import path from "node:path";

import type { RiskLevel } from "../../../contracts/permissions.js";
import type { ToolExecutionResult } from "../../tools/memory-tool-service.js";
import { BUILTIN_HOOK_HANDLERS, emptyHookResult } from "./builtin-handlers.js";
import { getMatchingHooks } from "./matcher.js";
import { HookRegistry } from "./registry.js";
import type {
  HookContext,
  HookDefinition,
  HookEventName,
  HookHandler,
  HookPermissionDecision,
  HookPhase,
  HookResult,
  RuntimeHookToolInput,
  WorkspaceTrustConfig,
  WorkspaceTrustValue,
} from "./types.js";

export class HookRuntimeService {
  private readonly registry = new HookRegistry();
  private readonly handlers = new Map<string, HookHandler>(Object.entries(BUILTIN_HOOK_HANDLERS));
  private workspaceTrust: WorkspaceTrustConfig = {
    default: "trusted",
    rules: [],
  };

  constructor(input: { enabled?: boolean; workspaceTrust?: WorkspaceTrustConfig | null } = {}) {
    if (input.workspaceTrust) {
      this.workspaceTrust = normalizeWorkspaceTrust(input.workspaceTrust);
    }
    if (input.enabled ?? true) {
      for (const hook of DEFAULT_SYSTEM_HOOKS) {
        this.registerHook(hook);
      }
    }
  }

  registerHook(hook: HookDefinition): void {
    this.registry.register(hook);
  }

  registerHandler(target: string, handler: HookHandler): void {
    this.handlers.set(target, handler);
  }

  clearHooks(): void {
    this.registry.clear();
  }

  listHooks(): HookDefinition[] {
    return this.registry.getAllHooks();
  }

  hasHooksForEvent(eventName: HookEventName): boolean {
    return this.registry.getHooksForEvent(eventName).length > 0;
  }

  resolveWorkspaceTrust(workspaceRoot?: string | null): WorkspaceTrustValue {
    if (!workspaceRoot) {
      return this.workspaceTrust.default;
    }
    const normalizedRoot = normalizePath(workspaceRoot);
    for (const rule of this.workspaceTrust.rules) {
      const normalizedPrefix = normalizePath(rule.workspaceRootPrefix);
      if (normalizedRoot === normalizedPrefix || normalizedRoot.startsWith(`${normalizedPrefix}/`)) {
        return rule.trust;
      }
    }
    return this.workspaceTrust.default;
  }

  async runToolHook(eventName: HookEventName, input: RuntimeHookToolInput): Promise<HookResult> {
    const candidateHooks = this.registry.getHooksForEvent(eventName);
    if (!candidateHooks.length) {
      return emptyHookResult();
    }
    const context = this.buildToolContext(eventName, input);
    const matchingHooks = getMatchingHooks(candidateHooks, context);
    if (!matchingHooks.length) {
      return emptyHookResult();
    }
    const results: HookResult[] = [];
    for (const hook of matchingHooks) {
      const result = await this.executeSingleHook(hook, context);
      results.push(result);
      if (result.blockExecution) {
        break;
      }
    }
    return mergeHookResults(results, eventName);
  }

  mergeHookData<T>(result: ToolExecutionResult<T>, hookResult: HookResult, phase: HookPhase): ToolExecutionResult<T> {
    const metadata = mergeHookMetadata(result.metadata, hookResult, phase);
    if (metadata === result.metadata) {
      return result;
    }
    return {
      ...result,
      metadata,
    };
  }

  private buildToolContext(eventName: HookEventName, input: RuntimeHookToolInput): HookContext {
    const context = input.context;
    const agent = context.agent ?? null;
    const permissionDecision = input.permissionDecision ?? null;
    const riskLevel = input.tool?.riskLevel ?? permissionDecision?.riskLevel ?? "low";
    const permissionMode = permissionDecision?.permissionMode ?? null;
    return {
      eventName,
      phase: phaseForEvent(eventName),
      timestamp: Date.now() / 1000,
      sessionId: context.sessionId ?? null,
      runId: context.runId ?? null,
      requestId: context.requestId ?? null,
      agent,
      agentName: context.currentAgentName ?? agent?.agent_name ?? null,
      agentDisplayName: agent?.display_name ?? context.currentAgentName ?? agent?.agent_name ?? null,
      caller: "direct",
      userRole: null,
      toolName: input.toolName,
      toolCallId: context.toolCallId ?? input.call.callId ?? null,
      parentCallId: context.parentCallId ?? null,
      round: context.round ?? null,
      order: context.order ?? null,
      roundIndex: context.roundIndex ?? null,
      workspaceTrust: this.resolveWorkspaceTrust(context.workspaceRoot),
      source: input.tool?.source ?? "runtime",
      inputSnapshot: { ...(input.call.arguments ?? {}) },
      resultSnapshot: input.result ? resultSnapshot(input.result) : {},
      errorSnapshot: input.error ? errorSnapshot(input.error) : {},
      metadata: {
        risk_level: riskLevel,
        permission_mode: permissionMode,
        tags: [],
      },
    };
  }

  private async executeSingleHook(hook: HookDefinition, context: HookContext): Promise<HookResult> {
    try {
      const result = await runWithTimeout(
        () => this.dispatchHook(hook, context),
        hook.timeoutMs ?? 1000,
      );
      return normalizeHookResult(result);
    } catch (error) {
      if (hook.failOpen ?? true) {
        return emptyHookResult();
      }
      return {
        ...emptyHookResult(),
        continueExecution: false,
        blockExecution: true,
        blockReason: `Hook ${hook.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private dispatchHook(hook: HookDefinition, context: HookContext): HookResult | Promise<HookResult> {
    if (hook.backend.type === "callback") {
      return emptyHookResult();
    }
    if (hook.backend.type === "prompt") {
      const prompt = typeof hook.backend.config?.prompt === "string" ? hook.backend.config.prompt : "";
      return {
        ...emptyHookResult(),
        additionalContext: prompt ? [formatPrompt(prompt, context)] : [],
      };
    }
    const handler = this.handlers.get(hook.backend.target);
    if (!handler) {
      throw new Error(`Hook handler is not registered: ${hook.backend.target}`);
    }
    return handler({
      context,
      config: hook.backend.config ?? {},
    });
  }
}

export const DEFAULT_SYSTEM_HOOKS: HookDefinition[] = [
  {
    id: "tool-risk-audit",
    name: "High-Risk Tool Audit",
    description: "Audit high-risk tool executions for security and compliance",
    enabled: true,
    source: "system",
    priority: 100,
    events: ["tool.after_execute"],
    matcher: {
      toolNames: ["execute_bash", "write_memory", "edit_file", "write_file"],
      callers: ["direct"],
    },
    backend: {
      type: "function",
      target: "hooks.builtin.tool_hooks:handle_risk_audit",
    },
  },
  {
    id: "bash-command-validation",
    name: "Bash Command Validation",
    description: "Validate bash commands for dangerous patterns",
    enabled: true,
    source: "system",
    priority: 300,
    events: ["tool.before_permission"],
    matcher: {
      toolNames: ["execute_bash"],
    },
    backend: {
      type: "function",
      target: "hooks.builtin.tool_hooks:handle_bash_command_validation",
    },
    failOpen: false,
  },
  {
    id: "memory-write-guard",
    name: "Memory Write Guard",
    description: "Add context about memory write operations",
    enabled: true,
    source: "system",
    priority: 150,
    events: ["tool.before_execute"],
    matcher: {
      toolNames: ["write_memory"],
    },
    backend: {
      type: "function",
      target: "hooks.builtin.tool_hooks:handle_memory_write_guard",
    },
  },
];

function mergeHookResults(results: HookResult[], eventName: HookEventName): HookResult {
  if (!results.length) {
    return emptyHookResult();
  }
  const merged: HookResult = emptyHookResult();
  for (const result of results) {
    if (result.blockExecution) {
      merged.continueExecution = false;
      merged.blockExecution = true;
      merged.blockReason = result.blockReason;
      break;
    }
  }
  const permissionPriority: Record<HookPermissionDecision, number> = {
    allow: 1,
    ask: 2,
    deny: 3,
  };
  let bestPermission: HookPermissionDecision | null = null;
  for (const result of results) {
    const permissionDecision = result.permissionDecision ?? null;
    if (
      permissionDecision &&
      (!bestPermission || permissionPriority[permissionDecision] > permissionPriority[bestPermission])
    ) {
      bestPermission = permissionDecision;
    }
  }
  if (bestPermission) {
    merged.permissionDecision = bestPermission;
  }
  const additionalContext = dedupe(results.flatMap((result) => result.additionalContext ?? []));
  if (additionalContext.length) {
    merged.additionalContext = additionalContext;
  }
  const uiMessage = results.map((result) => result.uiMessage).find((value) => typeof value === "string" && value.trim());
  if (uiMessage) {
    merged.uiMessage = uiMessage;
  }
  const uiMetadata = Object.assign({}, ...results.map((result) => result.uiMetadata ?? {})) as Record<string, unknown>;
  if (Object.keys(uiMetadata).length) {
    merged.uiMetadata = uiMetadata;
  }
  const tags = dedupe(results.flatMap((result) => result.tags ?? []));
  if (tags.length) {
    merged.tags = tags;
  }
  const metadata = Object.assign({}, ...results.map((result) => result.metadata ?? {})) as Record<string, unknown>;
  if (Object.keys(metadata).length) {
    merged.metadata = metadata;
  }
  const progress = results.map((result) => result.broadcastProgress).find((value) => typeof value === "string" && value.trim());
  if (progress) {
    merged.broadcastProgress = progress;
  }
  if (eventName === "tool.on_error" && !merged.tags?.length && !merged.metadata) {
    return merged;
  }
  return merged;
}

function normalizeHookResult(result: HookResult): HookResult {
  return {
    continueExecution: result.continueExecution ?? true,
    blockExecution: result.blockExecution ?? false,
    blockReason: result.blockReason ?? "",
    ...(result.permissionDecision ? { permissionDecision: result.permissionDecision } : {}),
    ...(result.additionalContext?.length ? { additionalContext: result.additionalContext } : {}),
    ...(result.uiMessage ? { uiMessage: result.uiMessage } : {}),
    ...(result.uiMetadata ? { uiMetadata: result.uiMetadata } : {}),
    ...(result.tags?.length ? { tags: result.tags } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
    ...(result.broadcastProgress ? { broadcastProgress: result.broadcastProgress } : {}),
  };
}

function mergeHookMetadata(metadata: Record<string, unknown>, hookResult: HookResult, phase: HookPhase): Record<string, unknown> {
  if (
    !hookResult.additionalContext?.length &&
    !hookResult.uiMessage &&
    !hookResult.uiMetadata &&
    !hookResult.tags?.length &&
    !hookResult.metadata &&
    !hookResult.permissionDecision
  ) {
    return metadata;
  }
  const next = { ...metadata };
  if (hookResult.additionalContext?.length) {
    next.hook_additional_context = {
      ...asRecord(next.hook_additional_context),
      [phase]: hookResult.additionalContext,
    };
  }
  if (hookResult.uiMessage) {
    next.hook_message = {
      ...asRecord(next.hook_message),
      [phase]: hookResult.uiMessage,
    };
  }
  if (hookResult.uiMetadata && Object.keys(hookResult.uiMetadata).length) {
    next.hook_metadata = {
      ...asRecord(next.hook_metadata),
      [phase]: hookResult.uiMetadata,
    };
  }
  if (hookResult.tags?.length) {
    const existingTags = asRecord(next.hook_tags);
    next.hook_tags = {
      ...existingTags,
      [phase]: dedupe([...(asStringArray(existingTags[phase]) ?? []), ...hookResult.tags]),
    };
  }
  if (hookResult.metadata && Object.keys(hookResult.metadata).length) {
    next.hook_phase_metadata = {
      ...asRecord(next.hook_phase_metadata),
      [phase]: hookResult.metadata,
    };
  }
  if (hookResult.permissionDecision) {
    next.hook_permission_decision = hookResult.permissionDecision;
  }
  return next;
}

function resultSnapshot(result: ToolExecutionResult): Record<string, unknown> {
  return {
    success: result.success,
    summary: result.summary,
    output_type: result.output_type,
    preview: typeof result.content === "string" ? result.content.slice(0, 500) : JSON.stringify(result.content).slice(0, 500),
    metadata: result.metadata,
  };
}

function errorSnapshot(error: unknown): Record<string, unknown> {
  return {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error",
  };
}

function phaseForEvent(eventName: HookEventName): HookPhase {
  if (eventName.startsWith("approval.")) {
    return eventName.replace(".", "_") as HookPhase;
  }
  return eventName.slice("tool.".length) as HookPhase;
}

function formatPrompt(prompt: string, context: HookContext): string {
  return prompt
    .replaceAll("{tool_name}", context.toolName ?? "")
    .replaceAll("{agent_name}", context.agentName ?? "")
    .replaceAll("{caller}", context.caller);
}

async function runWithTimeout<T>(operation: () => T | Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation();
  }
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function normalizeWorkspaceTrust(config: WorkspaceTrustConfig): WorkspaceTrustConfig {
  return {
    default: config.default === "untrusted" ? "untrusted" : "trusted",
    rules: config.rules
      .filter((rule) => rule.workspaceRootPrefix.trim())
      .map((rule) => ({
        workspaceRootPrefix: rule.workspaceRootPrefix,
        trust: rule.trust === "untrusted" ? "untrusted" : "trusted",
      })),
  };
}

function normalizePath(value: string): string {
  return path.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
