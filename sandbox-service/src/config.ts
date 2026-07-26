export interface SandboxServiceConfig {
  host: string;
  port: number;
  apiToken: string;
  runtimeImage: string;
  dockerRuntime: string | null;
  memory: string;
  cpus: string;
  pidsLimit: number;
  maxActiveLeases: number;
  maxRequestBytes: number;
  maxCommandOutputBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): SandboxServiceConfig {
  const apiToken = required(env.SANDBOX_API_TOKEN, "SANDBOX_API_TOKEN");
  if (apiToken.length < 24) throw new Error("SANDBOX_API_TOKEN must contain at least 24 characters");
  return {
    host: env.SANDBOX_SERVICE_HOST?.trim() || "0.0.0.0",
    port: positiveInteger(env.SANDBOX_SERVICE_PORT, 5003, "SANDBOX_SERVICE_PORT"),
    apiToken,
    runtimeImage: env.SANDBOX_RUNTIME_IMAGE?.trim() || "ragsystem-sandbox-runtime:local",
    dockerRuntime: env.SANDBOX_DOCKER_RUNTIME?.trim() || null,
    memory: env.SANDBOX_MEMORY?.trim() || "1g",
    cpus: env.SANDBOX_CPUS?.trim() || "1",
    pidsLimit: positiveInteger(env.SANDBOX_PIDS_LIMIT, 128, "SANDBOX_PIDS_LIMIT"),
    maxActiveLeases: positiveInteger(env.SANDBOX_MAX_ACTIVE_LEASES, 8, "SANDBOX_MAX_ACTIVE_LEASES"),
    maxRequestBytes: positiveInteger(env.SANDBOX_MAX_REQUEST_BYTES, 40 * 1024 * 1024, "SANDBOX_MAX_REQUEST_BYTES"),
    maxCommandOutputBytes: positiveInteger(env.SANDBOX_MAX_COMMAND_OUTPUT_BYTES, 2 * 1024 * 1024, "SANDBOX_MAX_COMMAND_OUTPUT_BYTES"),
  };
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
