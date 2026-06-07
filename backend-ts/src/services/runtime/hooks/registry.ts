import type { HookDefinition, HookEventName } from "./types.js";

export class HookRegistry {
  private readonly hooks = new Map<string, HookDefinition>();
  private readonly eventIndex = new Map<HookEventName, string[]>();

  register(hook: HookDefinition): void {
    this.unregister(hook.id);
    this.hooks.set(hook.id, normalizeHook(hook));
    for (const eventName of hook.events) {
      const ids = this.eventIndex.get(eventName) ?? [];
      ids.push(hook.id);
      this.eventIndex.set(eventName, ids);
    }
  }

  unregister(hookId: string): void {
    const existing = this.hooks.get(hookId);
    if (!existing) {
      return;
    }
    this.hooks.delete(hookId);
    for (const eventName of existing.events) {
      const next = (this.eventIndex.get(eventName) ?? []).filter((id) => id !== hookId);
      if (next.length) {
        this.eventIndex.set(eventName, next);
      } else {
        this.eventIndex.delete(eventName);
      }
    }
  }

  getHook(hookId: string): HookDefinition | null {
    return this.hooks.get(hookId) ?? null;
  }

  getHooksForEvent(eventName: HookEventName): HookDefinition[] {
    const ids = this.eventIndex.get(eventName) ?? [];
    return ids
      .map((id) => this.hooks.get(id))
      .filter((hook): hook is HookDefinition => Boolean(hook?.enabled))
      .sort((left, right) => {
        const priorityDelta = (right.priority ?? 100) - (left.priority ?? 100);
        if (priorityDelta !== 0) {
          return priorityDelta;
        }
        return ids.indexOf(left.id) - ids.indexOf(right.id);
      });
  }

  getAllHooks(): HookDefinition[] {
    return [...this.hooks.values()];
  }

  clear(): void {
    this.hooks.clear();
    this.eventIndex.clear();
  }
}

function normalizeHook(hook: HookDefinition): HookDefinition {
  return {
    ...hook,
    enabled: hook.enabled ?? true,
    source: hook.source ?? "system",
    priority: hook.priority ?? 100,
    matcher: hook.matcher ?? {},
    timeoutMs: hook.timeoutMs ?? 1000,
    failOpen: hook.failOpen ?? true,
    broadcast: hook.broadcast ?? true,
    tags: hook.tags ?? [],
  };
}
