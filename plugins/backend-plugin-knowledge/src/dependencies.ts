export interface KnowledgePluginLifecycle {
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export interface KnowledgePluginDependencies {
  lifecycle?: KnowledgePluginLifecycle;
}
