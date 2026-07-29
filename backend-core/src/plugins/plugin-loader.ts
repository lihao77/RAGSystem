import type {
  BackendPlugin,
  BackendPluginManifest,
  BackendPluginModule,
  InstalledBackendPluginSpec,
} from "./backend-plugin.js";

export const BACKEND_PLUGIN_MODULE_EXPORT = "backendPluginModule";

export type BackendPluginModuleImporter = (specifier: string) => Promise<unknown>;

export interface LoadBackendPluginsOptions {
  readonly importModule?: BackendPluginModuleImporter;
}

/** Dynamically imports only enabled plugin modules and creates validated plugin instances. */
export async function loadBackendPlugins(
  specs: readonly InstalledBackendPluginSpec[],
  options: LoadBackendPluginsOptions = {},
): Promise<readonly BackendPlugin[]> {
  const importModule = options.importModule ?? importBackendPluginModule;
  const plugins: BackendPlugin[] = [];

  for (const spec of specs) {
    if (spec.enabled === false) continue;
    const moduleSpecifier = normalizeModuleSpecifier(spec.module);
    let imported: unknown;
    try {
      imported = await importModule(moduleSpecifier);
    } catch (error) {
      throw new Error(`Failed to load backend plugin module '${moduleSpecifier}'`, { cause: error });
    }

    const pluginModule = readBackendPluginModule(imported, moduleSpecifier);
    let plugin: BackendPlugin;
    try {
      plugin = await pluginModule.create({ config: spec.config });
    } catch (error) {
      throw new Error(`Failed to create backend plugin '${pluginModule.manifest.id}' from '${moduleSpecifier}'`, {
        cause: error,
      });
    }
    validateCreatedPlugin(plugin, pluginModule.manifest, moduleSpecifier);
    plugins.push(plugin);
  }

  return plugins;
}

async function importBackendPluginModule(specifier: string): Promise<unknown> {
  return import(specifier);
}

function readBackendPluginModule(imported: unknown, moduleSpecifier: string): BackendPluginModule {
  if (!isRecord(imported)) {
    throw invalidModule(moduleSpecifier, "module namespace must be an object");
  }
  const candidate = imported[BACKEND_PLUGIN_MODULE_EXPORT];
  if (!isRecord(candidate)) {
    throw invalidModule(moduleSpecifier, `missing '${BACKEND_PLUGIN_MODULE_EXPORT}' export`);
  }
  if (candidate.apiVersion !== 1) {
    throw invalidModule(moduleSpecifier, `unsupported apiVersion '${String(candidate.apiVersion)}'`);
  }
  const manifest = validateManifest(candidate.manifest, moduleSpecifier);
  if (typeof candidate.create !== "function") {
    throw invalidModule(moduleSpecifier, "create must be a function");
  }
  return {
    apiVersion: 1,
    manifest,
    create: candidate.create as BackendPluginModule["create"],
  };
}

function validateCreatedPlugin(
  plugin: BackendPlugin,
  moduleManifest: BackendPluginManifest,
  moduleSpecifier: string,
): void {
  if (!isRecord(plugin)) throw invalidModule(moduleSpecifier, "create returned a non-object plugin");
  const pluginManifest = validateManifest(plugin.manifest, moduleSpecifier);
  if (pluginManifest.id !== moduleManifest.id) {
    throw invalidModule(
      moduleSpecifier,
      `created plugin id '${pluginManifest.id}' does not match module id '${moduleManifest.id}'`,
    );
  }
  if (pluginManifest.version !== moduleManifest.version) {
    throw invalidModule(
      moduleSpecifier,
      `created plugin version '${pluginManifest.version}' does not match module version '${moduleManifest.version}'`,
    );
  }
  if (typeof plugin.register !== "function") {
    throw invalidModule(moduleSpecifier, "created plugin register must be a function");
  }
}

function validateManifest(value: unknown, moduleSpecifier: string): BackendPluginManifest {
  if (!isRecord(value)) throw invalidModule(moduleSpecifier, "manifest must be an object");
  const id = normalizeRequiredString(value.id, "manifest.id", moduleSpecifier);
  const version = normalizeRequiredString(value.version, "manifest.version", moduleSpecifier);
  const requires = value.requires;
  if (requires !== undefined && (!Array.isArray(requires) || requires.some((item) => typeof item !== "string" || !item.trim()))) {
    throw invalidModule(moduleSpecifier, "manifest.requires must contain non-empty strings");
  }
  return requires === undefined
    ? { id, version }
    : { id, version, requires: requires.map((item) => (item as string).trim()) };
}

function normalizeModuleSpecifier(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Backend plugin module specifier must not be empty");
  return normalized;
}

function normalizeRequiredString(value: unknown, field: string, moduleSpecifier: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidModule(moduleSpecifier, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function invalidModule(moduleSpecifier: string, reason: string): Error {
  return new Error(`Invalid backend plugin module '${moduleSpecifier}': ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
