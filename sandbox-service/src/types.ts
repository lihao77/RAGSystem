export interface SandboxOwner {
  tenantId: string;
  userId: string;
  sessionId: string;
  runId: string;
}

export interface SandboxLeaseRecord {
  id: string;
  owner: SandboxOwner;
  containerName: string;
  inputVolume: string;
  workVolume: string;
  createdAt: string;
  expiresAt: string;
  expiresTimer: NodeJS.Timeout;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}
