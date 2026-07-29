import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { BackendPlugin, InstalledBackendPluginSpec } from "./backend-plugin.js";
import {
  loadBackendPlugins,
  type LoadBackendPluginsOptions,
} from "./plugin-loader.js";

export const DEFAULT_BACKEND_PLUGIN_CONFIG_FILE = "backend.plugins.yaml";

const PluginSpecSchema = z.object({
  module: z.string().trim().min(1),
  enabled: z.boolean().optional(),
  config: z.unknown().optional(),
}).strict();

const PluginConfigFileSchema = z.object({
  version: z.literal(1),
  plugins: z.array(PluginSpecSchema),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.plugins.forEach((plugin, index) => {
    if (seen.has(plugin.module)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["plugins", index, "module"],
        message: `Duplicate backend plugin module '${plugin.module}'`,
      });
    }
    seen.add(plugin.module);
  });
});

export interface BackendPluginConfigOptions {
  /** Base directory for the config path and default config discovery. */
  readonly cwd?: string;
  /** Environment used for ${NAME} substitutions inside enabled plugin config values. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface LoadConfiguredBackendPluginsOptions
  extends BackendPluginConfigOptions, LoadBackendPluginsOptions {
  /** Explicit YAML path. When omitted, backend.plugins.yaml is required under cwd. */
  readonly configPath?: string;
}

/** Loads and validates one backend plugin YAML file. */
export async function loadBackendPluginConfig(
  configPath: string,
  options: BackendPluginConfigOptions = {},
): Promise<readonly InstalledBackendPluginSpec[]> {
  const resolvedPath = resolveConfigPath(configPath, options.cwd);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read backend plugin config '${resolvedPath}'`, { cause: error });
  }
  return parseBackendPluginConfig(source, {
    sourcePath: resolvedPath,
    env: options.env ?? process.env,
  });
}

export interface ParseBackendPluginConfigOptions {
  readonly sourcePath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Parses YAML without importing plugin code or exposing resolved config values. */
export function parseBackendPluginConfig(
  source: string,
  options: ParseBackendPluginConfigOptions,
): readonly InstalledBackendPluginSpec[] {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new Error(`Invalid backend plugin YAML '${options.sourcePath}': ${errorMessage(error)}`);
  }

  const parsed = PluginConfigFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `Invalid backend plugin config '${options.sourcePath}': ${formatValidationIssues(parsed.error)}`,
    );
  }

  const configDirectory = path.dirname(path.resolve(options.sourcePath));
  const environment = options.env ?? process.env;
  try {
    return parsed.data.plugins.map((plugin, index) => {
      const spec: InstalledBackendPluginSpec = {
        module: resolvePluginModuleSpecifier(plugin.module, configDirectory),
        ...(plugin.enabled === undefined ? {} : { enabled: plugin.enabled }),
        ...(plugin.config === undefined || plugin.enabled === false
          ? {}
          : {
              config: interpolateEnvironment(
                plugin.config,
                environment,
                `plugins[${index}].config`,
                new WeakSet<object>(),
              ),
            }),
      };
      return spec;
    });
  } catch (error) {
    throw new Error(`Invalid backend plugin config '${options.sourcePath}': ${errorMessage(error)}`);
  }
}

/** Loads the required YAML manifest, then imports only its enabled modules. */
export async function loadConfiguredBackendPlugins(
  options: LoadConfiguredBackendPluginsOptions = {},
): Promise<readonly BackendPlugin[]> {
  const specs = await loadBackendPluginConfig(
    options.configPath?.trim() || DEFAULT_BACKEND_PLUGIN_CONFIG_FILE,
    {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    },
  );
  return loadBackendPlugins(specs, options.importModule ? { importModule: options.importModule } : {});
}

function resolveConfigPath(configPath: string, cwd = process.cwd()): string {
  const normalized = configPath.trim();
  if (!normalized) throw new Error("Backend plugin config path must not be empty");
  return path.resolve(cwd, normalized);
}

function resolvePluginModuleSpecifier(specifier: string, configDirectory: string): string {
  if (specifier.startsWith("file:")) return specifier;
  if (path.isAbsolute(specifier)) return pathToFileURL(specifier).href;
  const isRelativePath = specifier.startsWith("./")
    || specifier.startsWith("../")
    || specifier.startsWith(".\\")
    || specifier.startsWith("..\\");
  if (isRelativePath) {
    return pathToFileURL(path.resolve(configDirectory, specifier)).href;
  }
  return specifier;
}

function interpolateEnvironment(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  location: string,
  ancestors: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const resolved = environment[name];
      if (resolved === undefined) {
        throw new Error(`Backend plugin config '${location}' references missing environment variable '${name}'`);
      }
      return resolved;
    });
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new Error(`Backend plugin config '${location}' contains a circular YAML alias`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => interpolateEnvironment(
        item,
        environment,
        `${location}[${index}]`,
        ancestors,
      ));
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      interpolateEnvironment(item, environment, `${location}.${key}`, ancestors),
    ]));
  } finally {
    ancestors.delete(value);
  }
}

function formatValidationIssues(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${location}: ${issue.message}`;
  }).join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
