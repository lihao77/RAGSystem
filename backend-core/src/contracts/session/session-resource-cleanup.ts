export interface SessionResourceCleanup {
  cleanupSessionResources(sessionId: string): void | Promise<void>;
}
