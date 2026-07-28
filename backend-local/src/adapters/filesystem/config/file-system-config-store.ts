import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import type { SystemConfigData } from "@ragsystem/backend-core/contracts/runtime/system-config.js";
import type { ISystemConfigStore } from "@ragsystem/backend-core/contracts/runtime/system-config-store.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";

const SYSTEM_CONFIG_RELATIVE_PATH = path.join("config", "app", "config.yaml");

/** YAML-backed system config store used by Local deployments. */
export class FileSystemConfigStore implements ISystemConfigStore {
  private readonly configPath: string | null;

  constructor(options: { dataRoot?: string | undefined; configPath?: string | undefined } = {}) {
    this.configPath = resolveConfigPath(options);
  }

  async load(): Promise<SystemConfigData | null> {
    if (!this.configPath || !fs.existsSync(this.configPath)) {
      return null;
    }
    try {
      const parsed = YAML.parse(fs.readFileSync(this.configPath, "utf8")) as unknown;
      return isRecord(parsed) ? (structuredClone(parsed) as SystemConfigData) : null;
    } catch {
      return null;
    }
  }

  async save(config: SystemConfigData): Promise<void> {
    if (!this.configPath) {
      return;
    }
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, YAML.stringify(config), "utf8");
  }
}

function resolveConfigPath(options: {
  dataRoot?: string | undefined;
  configPath?: string | undefined;
}): string | null {
  if (options.configPath !== undefined) {
    const trimmed = options.configPath.trim();
    return trimmed ? path.resolve(trimmed) : null;
  }
  if (!options.dataRoot?.trim()) {
    return null;
  }
  return path.join(
    path.resolve(options.dataRoot || path.join(os.homedir(), ".ragsystem")),
    SYSTEM_CONFIG_RELATIVE_PATH,
  );
}
