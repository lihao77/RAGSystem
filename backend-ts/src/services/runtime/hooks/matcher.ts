import type { HookContext, HookDefinition, HookMatcher } from "./types.js";

export function matchesHook(hook: HookDefinition, context: HookContext): boolean {
  if (!matchesStructured(hook.matcher ?? {}, context)) {
    return false;
  }
  if (hook.ifExpr && !evaluateIfExpression(hook.ifExpr, context)) {
    return false;
  }
  return true;
}

export function getMatchingHooks(
  hooks: HookDefinition[],
  context: HookContext,
): HookDefinition[] {
  return hooks.filter((hook) => matchesHook(hook, context));
}

function matchesStructured(matcher: HookMatcher, context: HookContext): boolean {
  if (matcher.toolNames?.length && !includes(matcher.toolNames, context.toolName)) {
    return false;
  }
  if (matcher.agentNames?.length && !includes(matcher.agentNames, context.agentName)) {
    return false;
  }
  if (matcher.callers?.length && !matcher.callers.includes(context.caller)) {
    return false;
  }
  if (matcher.riskLevels?.length && !includes(matcher.riskLevels, asString(context.metadata.risk_level))) {
    return false;
  }
  if (matcher.workspaceTrust?.length && !matcher.workspaceTrust.includes(context.workspaceTrust)) {
    return false;
  }
  if (matcher.sessionIds?.length && !includes(matcher.sessionIds, context.sessionId)) {
    return false;
  }
  if (matcher.userRoles?.length && !includes(matcher.userRoles, context.userRole)) {
    return false;
  }
  if (matcher.whenResultSuccess !== null && matcher.whenResultSuccess !== undefined) {
    if (context.resultSnapshot.success !== matcher.whenResultSuccess) {
      return false;
    }
  }
  if (matcher.whenPermissionMode?.length && !includes(matcher.whenPermissionMode, asString(context.metadata.permission_mode))) {
    return false;
  }
  if (matcher.sources?.length && !matcher.sources.includes(context.source)) {
    return false;
  }
  if (matcher.tags?.length) {
    const tags = asStringArray(context.metadata.tags);
    if (!matcher.tags.some((tag) => tags.includes(tag))) {
      return false;
    }
  }
  return true;
}

function evaluateIfExpression(expression: string, context: HookContext): boolean {
  const trimmed = expression.trim();
  if (!trimmed) {
    return true;
  }
  const comparison = trimmed.match(/^context\.([a-zA-Z_][\w.]*)\s*(==|!=)\s*(['"])(.*?)\3$/);
  if (!comparison) {
    return false;
  }
  const [, path, operator, , expected] = comparison;
  const actual = readContextPath(context, path ?? "");
  if (operator === "==") {
    return actual === expected;
  }
  return actual !== expected;
}

function readContextPath(context: HookContext, valuePath: string): unknown {
  const allowed = new Set([
    "eventName",
    "phase",
    "sessionId",
    "runId",
    "agentName",
    "agentDisplayName",
    "caller",
    "userRole",
    "toolName",
    "toolCallId",
    "round",
    "order",
    "workspaceTrust",
    "source",
  ]);
  if (allowed.has(valuePath)) {
    return context[valuePath as keyof HookContext];
  }
  if (valuePath.startsWith("metadata.")) {
    return context.metadata[valuePath.slice("metadata.".length)];
  }
  return undefined;
}

function includes(values: readonly string[], value: string | null): boolean {
  return value !== null && values.includes(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
