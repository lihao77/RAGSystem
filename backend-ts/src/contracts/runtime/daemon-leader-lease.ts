/** Process-wide lease for singleton daemon side effects (long connections/webhooks). */
export interface DaemonLeaderLease {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}
