import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

import type { SandboxServiceConfig } from "./config.js";
import type { CommandResult, SandboxLeaseRecord, SandboxOwner } from "./types.js";

const MANAGED_LABEL = "com.ragsystem.sandbox.managed=true";

export class DockerCommandError extends Error {
  constructor(
    message: string,
    readonly command: string[],
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "DockerCommandError";
  }
}

export class DockerSandboxEngine {
  constructor(private readonly config: SandboxServiceConfig) {}

  async verify(): Promise<void> {
    await this.run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    await this.run(["image", "inspect", this.config.runtimeImage], { timeoutMs: 15_000 });
    if (this.config.dockerRuntime) {
      const info = await this.run(["info", "--format", "{{json .Runtimes}}"], { timeoutMs: 15_000 });
      const runtimes = JSON.parse(info.stdout) as Record<string, unknown>;
      if (!(this.config.dockerRuntime in runtimes)) {
        throw new Error(`Docker runtime is not registered: ${this.config.dockerRuntime}`);
      }
    }
  }

  async cleanupManagedResources(): Promise<void> {
    const containers = splitLines((await this.run([
      "ps", "-aq", "--filter", `label=${MANAGED_LABEL}`,
    ], { allowFailure: true })).stdout);
    if (containers.length) await this.run(["rm", "-f", ...containers], { allowFailure: true, timeoutMs: 60_000 });
    const volumes = splitLines((await this.run([
      "volume", "ls", "-q", "--filter", `label=${MANAGED_LABEL}`,
    ], { allowFailure: true })).stdout);
    if (volumes.length) await this.run(["volume", "rm", "-f", ...volumes], { allowFailure: true, timeoutMs: 60_000 });
  }

  async create(owner: SandboxOwner, timeoutSeconds: number): Promise<Omit<SandboxLeaseRecord, "expiresTimer">> {
    const id = randomUUID().replaceAll("-", "");
    const shortId = id.slice(0, 20);
    const containerName = `ragsystem-sbx-${shortId}`;
    const inputVolume = `ragsystem-sbx-${shortId}-input`;
    const workVolume = `ragsystem-sbx-${shortId}-work`;
    const ownerHash = createHash("sha256")
      .update([owner.tenantId, owner.userId, owner.sessionId, owner.runId].join("\0"))
      .digest("hex");
    const labels = [
      "--label", MANAGED_LABEL,
      "--label", `com.ragsystem.sandbox.id=${id}`,
      "--label", `com.ragsystem.sandbox.owner-sha256=${ownerHash}`,
    ];

    try {
      for (const volume of [inputVolume, workVolume]) {
        await this.run(["volume", "create", ...labels, volume], { timeoutMs: 15_000 });
      }
      await this.run([
        "run", "--rm", "--network", "none", "--user", "0:0",
        "--read-only",
        "--cap-drop", "ALL",
        "--cap-add", "CHOWN",
        "--cap-add", "FOWNER",
        "--security-opt", "no-new-privileges",
        "--pids-limit", String(this.config.pidsLimit),
        "--memory", this.config.memory,
        "--cpus", this.config.cpus,
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864",
        "--mount", `type=volume,src=${inputVolume},dst=/input`,
        "--mount", `type=volume,src=${workVolume},dst=/work`,
        this.config.runtimeImage,
        "node", "/opt/ragsystem/helper.mjs", "initialize",
      ], { timeoutMs: 30_000 });

      const createArgs = [
        "create", "--name", containerName, ...labels,
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", String(this.config.pidsLimit),
        "--memory", this.config.memory,
        "--cpus", this.config.cpus,
        "--user", "10001:10001",
        "--env", "HOME=/work",
        "--env", "TMPDIR=/tmp",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864",
        "--mount", `type=volume,src=${inputVolume},dst=/input,readonly`,
        "--mount", `type=volume,src=${workVolume},dst=/work`,
        ...(this.config.dockerRuntime ? ["--runtime", this.config.dockerRuntime] : []),
        this.config.runtimeImage,
        "sleep", "infinity",
      ];
      await this.run(createArgs, { timeoutMs: 30_000 });
      await this.run(["start", containerName], { timeoutMs: 30_000 });
    } catch (error) {
      await this.destroyResources(containerName, inputVolume, workVolume);
      throw error;
    }

    const createdAt = new Date();
    return {
      id,
      owner,
      containerName,
      inputVolume,
      workVolume,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + timeoutSeconds * 1_000).toISOString(),
    };
  }

  async destroy(lease: Pick<SandboxLeaseRecord, "containerName" | "inputVolume" | "workVolume">): Promise<void> {
    await this.destroyResources(lease.containerName, lease.inputVolume, lease.workVolume);
  }

  async stageInput(lease: SandboxLeaseRecord, input: unknown): Promise<unknown> {
    return this.runHelperContainer(lease.inputVolume, "stage-input", input);
  }

  async fileOperation(lease: SandboxLeaseRecord, operation: string, input: unknown): Promise<unknown> {
    const result = await this.run([
      "exec", "-i", lease.containerName,
      "node", "/opt/ragsystem/helper.mjs", operation,
    ], { input: JSON.stringify(input), timeoutMs: 60_000, maxOutputBytes: this.config.maxCommandOutputBytes });
    return parseJson(result.stdout, `sandbox file operation ${operation}`);
  }

  async execute(lease: SandboxLeaseRecord, kind: "bash" | "code", input: unknown): Promise<unknown> {
    const result = await this.run([
      "exec", "-i", lease.containerName,
      "node", "/opt/ragsystem/runner.mjs", kind,
    ], { input: JSON.stringify(input), timeoutMs: 620_000, maxOutputBytes: this.config.maxCommandOutputBytes + 64 * 1024 });
    return parseJson(result.stdout, `sandbox ${kind} execution`);
  }

  private async runHelperContainer(inputVolume: string, operation: string, input: unknown): Promise<unknown> {
    const result = await this.run([
      "run", "--rm", "-i", "--network", "none", "--user", "0:0",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(this.config.pidsLimit),
      "--memory", this.config.memory,
      "--cpus", this.config.cpus,
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864",
      "--mount", `type=volume,src=${inputVolume},dst=/input`,
      this.config.runtimeImage,
      "node", "/opt/ragsystem/helper.mjs", operation,
    ], { input: JSON.stringify(input), timeoutMs: 60_000, maxOutputBytes: this.config.maxCommandOutputBytes });
    return parseJson(result.stdout, `sandbox input operation ${operation}`);
  }

  private async destroyResources(containerName: string, ...volumes: string[]): Promise<void> {
    await this.run(["rm", "-f", containerName], { allowFailure: true, timeoutMs: 30_000 });
    await this.run(["volume", "rm", "-f", ...volumes], { allowFailure: true, timeoutMs: 30_000 });
  }

  private async run(
    args: string[],
    options: {
      input?: string;
      timeoutMs?: number;
      maxOutputBytes?: number;
      allowFailure?: boolean;
    } = {},
  ): Promise<CommandResult> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const maxOutputBytes = options.maxOutputBytes ?? this.config.maxCommandOutputBytes;
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let truncated = false;
      let timedOut = false;
      const append = (chunks: Buffer[], chunk: Buffer, current: number): number => {
        if (current >= maxOutputBytes) {
          truncated = true;
          return current;
        }
        const accepted = chunk.subarray(0, Math.max(0, maxOutputBytes - current));
        chunks.push(accepted);
        if (accepted.byteLength < chunk.byteLength) truncated = true;
        return current + accepted.byteLength;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes); });
      child.on("error", reject);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref();
      child.on("close", (code) => {
        clearTimeout(timer);
        const result: CommandResult = {
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: Buffer.concat(stderr).toString("utf8").trim(),
          exitCode: code ?? -1,
          truncated,
        };
        if (timedOut) {
          reject(new DockerCommandError(`Docker command timed out after ${timeoutMs}ms`, args, result));
          return;
        }
        if (result.exitCode !== 0 && !options.allowFailure) {
          reject(new DockerCommandError(result.stderr || `Docker command failed with exit code ${result.exitCode}`, args, result));
          return;
        }
        resolve(result);
      });
      child.stdin.end(options.input ?? "");
    });
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON returned by ${label}`);
  }
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}
