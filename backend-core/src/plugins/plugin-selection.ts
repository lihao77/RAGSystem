import type { BackendPlugin } from "./backend-plugin.js";

export type BackendPluginCatalog = Readonly<Record<string, () => BackendPlugin>>;

export function selectBackendPlugins(
  catalog: BackendPluginCatalog,
  selection: string | undefined,
): readonly BackendPlugin[] {
  const available = Object.keys(catalog);
  const requested = parseSelection(selection, available);
  return requested.map((name) => {
    const create = catalog[name];
    if (!create) throw new Error(`Backend plugin '${name}' is not installed`);
    return create();
  });
}

function parseSelection(selection: string | undefined, available: readonly string[]): string[] {
  const normalized = selection?.trim();
  if (!normalized || normalized === "all") return [...available];
  if (normalized === "none") return [];
  const names = normalized.split(",").map((name) => name.trim()).filter(Boolean);
  if (new Set(names).size !== names.length) throw new Error("BACKEND_PLUGINS contains duplicate names");
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new Error(`Backend plugins are not installed: ${unknown.join(", ")}; available: ${available.join(", ")}`);
  }
  return names;
}
