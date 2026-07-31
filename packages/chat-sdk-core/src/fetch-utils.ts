export function bindFetch(fetchImpl: typeof fetch | undefined): typeof fetch | undefined {
  if (typeof fetchImpl !== "function") return undefined;
  return fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl;
}

export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Record<string, string> {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, name) => merged.set(name, value));
  }
  return Object.fromEntries(merged.entries());
}
