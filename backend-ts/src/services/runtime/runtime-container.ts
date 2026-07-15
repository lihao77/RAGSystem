import { createAgentExecutionService, type AgentExecutionService } from "../agent/execution/index.js";
import type { AgentExecutionLogger } from "../agent/execution/index.js";
import { AgentDelegationService } from "../agent/delegation/index.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { BackgroundTaskService } from "./background-task-service.js";
import { SessionNotificationQueue } from "./session-notification-queue.js";
import { AgentConfigService } from "../agent/config/index.js";
import { AgentSessionApplication } from "../sessions/index.js";
import { ArtifactService } from "../artifacts/artifact-service.js";
import { TransientArtifactService } from "../artifacts/transient-artifact-service.js";
import { createConversationStore, type ConversationStore } from "../stores/conversation-store/index.js";
import { EmbeddingModelService } from "../knowledge/embedding-model-service.js";
import { FileHistoryService } from "../stores/file-history-service.js";
import type { IFileHistoryStore } from "../../contracts/file-history-store/index.js";
import { FileIndexService } from "../stores/file-index-service.js";
import type { IFileIndexStore } from "../../contracts/file-index-store/index.js";
import { RealtimeEventHub } from "./realtime-event-hub.js";
import { LocalBashToolService } from "../../tools/BashTool/BashExecution.js";
import { CodeExecutionToolService } from "../../tools/CodeExecutionTool/CodeExecution.js";
import { LocalDocumentToolService } from "../../tools/DocumentTools/DocumentExecution.js";
import { LocalSearchToolService } from "../../tools/LocalSearchTools/SearchExecution.js";
import { SkillToolService } from "../../tools/SkillTools/SkillExecution.js";
import { SkillLibraryService } from "../skills/skill-library-service.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import { MemoryStore } from "../stores/memory-store.js";
import { MemoryToolService } from "../../tools/MemoryTools/MemoryExecution.js";
import { McpService } from "../integrations/mcp-service.js";
import { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { DelegationPendingService } from "./delegation-pending-service.js";
import { HostToolRegistry } from "./host-tool-registry.js";
import { PendingInteractionService } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";
import { RuntimeCoreService } from "../agent/execution/runtime-core-service.js";
import { SystemConfigService } from "../config/system-config-service.js";
import { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import { KnowledgeBaseService, type KnowledgeBaseEmbedderFactory } from "../knowledge/knowledge-base-service.js";
import { DocumentExtractDispatcher } from "../knowledge/document-extract/dispatcher.js";
import { createVectorStoreFromConfig } from "../vector-store/vector-store-factory.js";
import type { IVectorStore } from "../../contracts/vector-store/index.js";
import { OutboxDispatcher } from "./event-outbox/dispatcher.js";
import { DurableClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import { AgentMetricsCollector } from "../agent/metrics/metrics-collector.js";
import { AgentCompressionService } from "../agent/context-compression/compression-service.js";
import type { TenantId } from "../../identity/types.js";

export interface RuntimeContainer {
  readonly conversationStore: ConversationStore;
  readonly sessionApplication: AgentSessionApplication;
  readonly realtimeEvents: RealtimeEventHub;
  readonly agentExecution: AgentExecutionService;
  /** 智能体性能指标采集器（/metrics 端点读其聚合结果）。 */
  readonly metricsCollector: AgentMetricsCollector;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly mcp: McpService;
  readonly fileHistory: IFileHistoryStore;
  readonly fileIndex: IFileIndexStore;
  readonly knowledgeBase: KnowledgeBaseService;
  readonly artifacts: ArtifactService;
  readonly transientArtifacts: TransientArtifactService;
  readonly embeddingModels: EmbeddingModelService;
  readonly memoryStore: MemoryStore;
  readonly memoryTools: MemoryToolService;
  readonly documentTools: LocalDocumentToolService;
  readonly codeExecutionTools: CodeExecutionToolService;
  readonly skillTools: SkillToolService;
  readonly skillLibrary: SkillLibraryService;
  readonly searchTools: LocalSearchToolService;
  readonly bashTools: LocalBashToolService;
  readonly backgroundTasks: BackgroundTaskService;
  readonly taskTools: TaskToolService;
  readonly pendingInteractions: PendingInteractionService;
  readonly hostToolRegistry: HostToolRegistry;
  readonly delegationPending: DelegationPendingService;
  /** per-agent 工具依赖集合（runtime-adapter per-run 构建 Tool[] 用）。 */
  readonly toolsDeps: Omit<import("../../tools/registry.js").BackendToolsDeps, "agent" | "teamName">;
  readonly runtimeCore: RuntimeCoreService;
  readonly agentDelegation: AgentDelegationService;
  readonly outboxDispatcher: OutboxDispatcher;
  readonly clientEvents: DurableClientEventPublisher;
  /** 数据根目录（memory store / 工具数据用）；snapshot 装配 createRuntime 时透传。 */
  readonly dataRoot: string;
  close(): void;
}

export interface RuntimeContainerOptions {
  tenantId: TenantId;
  dbPath: string;
  dataRoot?: string | undefined;
  logger?: AgentExecutionLogger | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  mcpConfigPath?: string | undefined;
  systemConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
  startOutboxDispatcher?: boolean | undefined;
  outboxDispatcherIntervalMs?: number | undefined;
  /** 消费端 hook 注册回调（可选）；透传 SDK，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: ((registry: HookRegistry) => void) | undefined;
  /** 测试或离线运行可注入确定性 embedder；生产默认按 provider 配置解析。 */
  embedderFactory?: KnowledgeBaseEmbedderFactory | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot });
  const fileHistory = new FileHistoryService({ dataRoot });
  const transientArtifacts = new TransientArtifactService(dataRoot);
  transientArtifacts.startPruning();
  const sessionApplication = new AgentSessionApplication(conversationStore, fileHistory, transientArtifacts);
  const realtimeEvents = new RealtimeEventHub();
  const outboxDispatcher = new OutboxDispatcher(conversationStore, realtimeEvents);
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  const clientEvents = new DurableClientEventPublisher(conversationStore, outboxDispatcher);
  const permissionPolicy = new PermissionPolicyService();
  const agentConfig = new AgentConfigService({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService({ dataRoot: options.dataRoot, configPath: options.systemConfigPath });
  const memoryConfig = systemConfig.getMemoryConfig();
  const mcp = new McpService({ dataRoot: options.dataRoot, configPath: options.mcpConfigPath });
  void mcp.autoConnectEnabledServers();
  agentConfig.setMcpService(mcp);
  const fileIndex = new FileIndexService({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  // sqlite-vec driver 接线:读 systemConfig 选后端实例化(触发 driver 模块自注册)。
  // sqlite-vec 是唯一向量源(driver 唯一);扩展加载失败(vec0 不可用、Node/Windows ABI)直接抛错,
  // 让启动显式报错而非静默降级到无向量的空检索——5h-2 已删旧 hash 应用层降级路径。
  // dbPath=:memory: 是临时库信号(测试/瞬态),知识库随之走 :memory:,与主库同生命周期、随 container 关闭重置;
  // 否则知识库会落到共享 dataRoot/db/knowledge.db 文件,跨实例泄漏配置(vectorizer/reranker)。
  const vectorStoreConfig = systemConfig.getVectorStoreConfig();
  const resolvedVectorStoreConfig =
    options.dbPath === ":memory:"
      ? { ...vectorStoreConfig, sqlite_vec: { ...vectorStoreConfig.sqlite_vec, database_path: ":memory:" } }
      : vectorStoreConfig;
  const vectorStore = createVectorStoreFromConfig(resolvedVectorStoreConfig, options.dataRoot);
  const documentExtractDispatcher = new DocumentExtractDispatcher(systemConfig.getDocumentExtractionConfig());
  // vectorStore 同一对象同时实现 IVectorStore(数据面) + IKnowledgeConfig(配置面),
  // 共享 knowledge.db 单一连接——主库 ragsystem.db 不再涉及向量/配置面。
  const knowledgeBase = new KnowledgeBaseService(modelAdapter, {
    vectorStore,
    knowledgeConfig: vectorStore,
    knowledgeFileStore: vectorStore,
    documentExtractDispatcher,
    ...(options.embedderFactory ? { embedderFactory: options.embedderFactory } : {}),
  });
  const artifacts = new ArtifactService({ dataRoot: options.dataRoot });
  const embeddingModels = new EmbeddingModelService(knowledgeBase);
  const memoryStore = new MemoryStore({ dataRoot: options.dataRoot });
  const memoryTools = new MemoryToolService(memoryStore, conversationStore);
  const documentTools = new LocalDocumentToolService({ dataRoot: options.dataRoot, fileHistory });
  // 后台通知暂存队列（单一数据来源）：backgroundTasks 生产（完成入队）+ launchers.triggerBgNotificationRun
  // 消费（drain 起 system run）共用同一实例；执行层直接注入该队列。
  const notificationQueue = new SessionNotificationQueue();
  const backgroundTasks = new BackgroundTaskService({ notificationQueue });
  const toolsConfig = systemConfig.getToolsConfig();
  const codeExecutionTools = new CodeExecutionToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.code_default_timeout,
    maxTimeoutSeconds: toolsConfig.code_max_timeout,
  });
  const skillTools = new SkillToolService({
    dataRoot: options.dataRoot,
    agentConfig,
    artifacts,
    backgroundTasks,
    clientEvents,
  });
  agentConfig.setSkillToolService(skillTools);
  const skillLibrary = new SkillLibraryService(skillTools);
  const searchTools = new LocalSearchToolService({ dataRoot: options.dataRoot });
  const bashTools = new LocalBashToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: toolsConfig.bash_default_timeout,
    maxTimeoutSeconds: toolsConfig.bash_max_timeout,
    maxOutputChars: toolsConfig.bash_max_output,
    backgroundTasks,
    clientEvents,
  });
  const taskTools = new TaskToolService(backgroundTasks, notificationQueue, { dataRoot: options.dataRoot });
  const pendingInteractions = new PendingInteractionService(clientEvents);
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();
  // agentDelegation 需先实例化（工具依赖它），但其 runEngine/eventPublisher 延迟设置。
  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const agentDelegation = new AgentDelegationService(
    conversationStore,
    runtimeCore,
    clientEvents,
  );
  // per-agent 工具依赖（agent/teamName 由 runtime-adapter per-run 提供）
  const toolsDeps = {
    memoryTools,
    pendingInteractions,
    documentTools,
    bashTools,
    taskTools,
    searchTools,
    knowledgeBase,
    mcp,
    codeExecutionTools,
    skillTools,
    getAgentDelegation: () => agentDelegation,
    agentConfig,
  };
  // 性能监控采集器:复用 conversationStore 的 metricOps(IMetricStore),供 AgentRunEngine 终态落库 + /metrics 读取。
  const metricsCollector = new AgentMetricsCollector(conversationStore);
  const agentExecution = createAgentExecutionService({
    tenantId: options.tenantId,
    sessions: sessionApplication,
    conversationStore,
    runtimeCore,
    dataRoot,
    memoryConfig,
   toolsDeps,
   codeExecutionTools,
   taskTools,
   providersProvider: () => modelAdapter.listProviders(),
   backgroundTasks,
   notificationQueue,
    fileIndex,
    outboxDispatcher,
    clientEvents,
    permissionPolicy,
    pendingInteractions,
    hostToolRegistry,
    delegationPending,
    logger: options.logger,
    metricsCollector,
    compressionService: new AgentCompressionService(
      conversationStore,
      () => modelAdapter.listProviders(),
      systemConfig,
    ),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  agentDelegation.setRunEngine(() => agentExecution.runEngine);
  // 后台任务完成 → 自动拉起 system run（通道 A）。lazy 绑定打破 backgroundTasks ↔ agentExecution 循环。
  backgroundTasks.setOnTaskCompleted((sessionId) => agentExecution.triggerBgNotificationRun(sessionId));
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    backgroundTasks.dispose();
    transientArtifacts.stopPruning();
    outboxDispatcher.stop();
    mcp.close();
    knowledgeBase.close();
    fileIndex.close();
    // conversation/file-index/vector 三个 store 各自开 SQLite 句柄（同 dbPath，WAL 允许多连接），
    // 各自需 close 释放文件句柄/WAL。conversationStore 是最底层（被 sessionApplication/outbox 等
    // 依赖），其上层已先关，故最后关。fileHistory/memoryStore 纯文件无句柄，无需 close。
    conversationStore.close();
  };
  return {
    conversationStore,
    sessionApplication,
    realtimeEvents,
    agentExecution,
    metricsCollector,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    fileHistory,
    fileIndex,
    knowledgeBase,
    artifacts,
    transientArtifacts,
    embeddingModels,
    memoryStore,
    memoryTools,
    documentTools,
    codeExecutionTools,
    skillTools,
    skillLibrary,
    searchTools,
    bashTools,
    backgroundTasks,
    taskTools,
    pendingInteractions,
    hostToolRegistry,
    delegationPending,
    toolsDeps,
    runtimeCore,
    agentDelegation,
    outboxDispatcher,
    clientEvents,
    dataRoot,
    close,
  };
}
