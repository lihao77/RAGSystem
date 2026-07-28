export interface CapabilityToken<Value> {
  readonly id: string;
  readonly __valueType?: Value;
}

export interface CapabilityProvider<Value = unknown> {
  readonly token: CapabilityToken<Value>;
  readonly value: Value;
  readonly owner?: string;
}

export function createCapability<Value>(id: string): CapabilityToken<Value> {
  const normalized = id.trim();
  if (!normalized) throw new Error("Capability id must not be empty");
  return Object.freeze({ id: normalized });
}

export function provideCapability<Value>(
  token: CapabilityToken<Value>,
  value: Value,
  owner?: string,
): CapabilityProvider<Value> {
  return owner ? { token, value, owner } : { token, value };
}

export class CapabilityRegistry {
  private readonly values = new Map<string, { value: unknown; owner?: string }>();

  constructor(providers: readonly CapabilityProvider[] = []) {
    for (const provider of providers) {
      this.provide(provider.token, provider.value, provider.owner);
    }
  }

  provide<Value>(token: CapabilityToken<Value>, value: Value, owner?: string): void {
    const existing = this.values.get(token.id);
    if (existing) {
      const suffix = existing.owner ? ` by ${existing.owner}` : "";
      throw new Error(`Capability '${token.id}' is already provided${suffix}`);
    }
    this.values.set(token.id, owner ? { value, owner } : { value });
  }

  has(token: CapabilityToken<unknown>): boolean {
    return this.values.has(token.id);
  }

  get<Value>(token: CapabilityToken<Value>): Value | undefined {
    return this.values.get(token.id)?.value as Value | undefined;
  }

  require<Value>(token: CapabilityToken<Value>): Value {
    const value = this.get(token);
    if (value === undefined) throw new Error(`Required capability '${token.id}' is not available`);
    return value;
  }

  list(): readonly string[] {
    return Array.from(this.values.keys()).sort();
  }
}
