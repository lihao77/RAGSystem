/** A typed resource contract shared by a provider and its consumers. */
export interface BackendResourceToken<Value> {
  readonly id: string;
  readonly owner: string;
  readonly __valueType?: Value;
  readonly validate?: (value: unknown) => boolean;
}

export function createBackendResourceToken<Value>(
  id: string,
  owner: string,
  validate?: (value: unknown) => boolean,
): BackendResourceToken<Value> {
  const normalizedId = id.trim();
  const normalizedOwner = owner.trim();
  if (!normalizedId) throw new Error("Backend resource id must not be empty");
  if (!normalizedOwner) throw new Error("Backend resource owner must not be empty");
  return Object.freeze({
    id: normalizedId,
    owner: normalizedOwner,
    ...(validate ? { validate } : {}),
  });
}

export interface BackendPluginResourceContribution<Value = unknown> {
  /** The deployment or plugin that supplied this value. */
  readonly providerId: string;
  readonly token: BackendResourceToken<Value>;
  readonly value: Value;
}

export function provideBackendResource<Value>(
  token: BackendResourceToken<Value>,
  value: Value,
  providerId: string,
): BackendPluginResourceContribution<Value> {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) throw new Error("Backend resource provider id must not be empty");
  if (token.validate && !token.validate(value)) {
    throw new Error(`Invalid value for backend resource '${token.id}'`);
  }
  return { providerId: normalizedProviderId, token, value };
}

export function findBackendResource<Value>(
  resources: readonly BackendPluginResourceContribution[] | undefined,
  token: BackendResourceToken<unknown>,
): Value | undefined {
  const matches = resources?.filter((resource) => resource.token.id === token.id) ?? [];
  if (matches.length > 1) {
    throw new Error(`Backend resource '${token.id}' has multiple providers: ${matches.map((item) => item.providerId).join(", ")}`);
  }
  const resource = matches[0];
  if (!resource) return undefined;
  if (resource.token.owner !== token.owner) {
    throw new Error(`Backend resource '${token.id}' is owned by '${resource.token.owner}', expected '${token.owner}'`);
  }
  if (token.validate && !token.validate(resource.value)) {
    throw new Error(`Invalid value for backend resource '${token.id}' from '${resource.providerId}'`);
  }
  return resource.value as Value;
}

export function requireBackendResource<Value>(
  resources: readonly BackendPluginResourceContribution[] | undefined,
  token: BackendResourceToken<unknown>,
): Value {
  const value = findBackendResource(resources, token);
  if (value === undefined) throw new Error(`Required backend resource '${token.id}' is not available`);
  return value as Value;
}
