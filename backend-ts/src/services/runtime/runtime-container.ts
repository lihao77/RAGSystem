import { createAgentExecutionService, type AgentExecutionService } from "../agent/execution/index.js";
import type { AgentExecutionLogger } from "../agent/execution/index.js";
import { AgentContextService } from "../agent/context/index.js";
import { AgentDelegationService } from "../agent/delegation/index.js";
import os from "node:os";
import path from "node:path";
import { BackgroundTaskService } from "./background-task-service.js";
import { AgentConfigService } from "../agent/config/index.js";
import { AgentSessionApplication } from "../sessions/index.js";
import { ArtifactService } from "../artifacts/artifact-service.js";
import { createConversationStore, type ConversationStore } from "../stores/conversation-store/index.js";
import { DaemonService } from "../daemon/daemon-service.js";
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
import { SqliteRuntimeStore } from "@ragsystem/agent-sdk";
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
import { VectorLibraryService } from "../knowledge/vector-library-service.js";
import { createVectorStoreFromConfig } from "../vector-store/vector-store-factory.js";
import type { IVectorStore } from "../../contracts/vector-store/index.js";
import { OutboxDispatcher } from "./event-outbox/dispatcher.js";
import { DurableClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import { createWidgetCredentialStore, type WidgetCredentialStore } from "../stores/widget-credential-store/index.js";
import { createWidgetAuthService, type WidgetAuthService } from "./jwt-service.js";
import { AgentMetricsCollector } from "../agent/metrics/metrics-collector.js";
import { AgentCompressionService } from "../agent/context-compression/compression-service.js";

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
  readonly daemon: DaemonService;
  readonly fileHistory: IFileHistoryStore;
  readonly fileIndex: IFileIndexStore;
  readonly vectorLibrary: VectorLibraryService;
  readonly artifacts: ArtifactService;
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
  readonly agentContextService: AgentContextService;
  readonly agentDelegation: AgentDelegationService;
  readonly outboxDispatcher: OutboxDispatcher;
  readonly clientEvents: DurableClientEventPublisher;
  /** widget 凭证存储（optional，与 widgetAuth 同生命周期；管理 app 凭证用）。 */
  readonly widgetCredentialStore?: WidgetCredentialStore;
  /**
   * widget 第三方嵌入鉴权（optional）。仅当配了 WIDGET_JWT_SECRET 才实例化；
   * 未配时为 undefined，widget 路由与 ws 握手鉴权跳过，后端保持现状。
   */
  readonly widgetAuth?: WidgetAuthService;
  /** SDK 共享 store（指向同一 ragsystem.db；createRuntime 复用，container close 时关）。 */
  readonly sdkStore: SqliteRuntimeStore;
  /** 数据根目录（memory store / 工具数据用）；snapshot 装配 createRuntime 时透传。 */
  readonly dataRoot: string;
  close(): void;
}

export interface RuntimeContainerOptions {
  dbPath: string;
  dataRoot?: string | undefined;
  logger?: AgentExecutionLogger | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  mcpConfigPath?: string | undefined;
  daemonConfigPath?: string | undefined;
  systemConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
  startOutboxDispatcher?: boolean | undefined;
  outboxDispatcherIntervalMs?: number | undefined;
  /** 消费端 hook 注册回调（可选）；透传 SDK，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: ((registry: HookRegistry) => void) | undefined;
  /** widget JWT 签名密钥（optional）。非空才启用 widget 鉴权与受约束会话签发。 */
  widgetJwtSecret?: string | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  // SDK store 归位：共享 SqliteRuntimeStore 指向同一 ragsystem.db，所有 createRuntime 复用同一连接（避免 per-call 连接泄漏）。
  const sdkStore = new SqliteRuntimeStore({ dbPath: options.dbPath });
  const fileHistory = new FileHistoryService({ dataRoot: options.dataRoot });
  const sessionApplication = new AgentSessionApplication(conversationStore, fileHistory);
  const realtimeEvents = new RealtimeEventHub();
  // widget 鉴权（optional）：配了 WIDGET_JWT_SECRET 才装配。复用同一 dbPath，独立句柄，close 时单独释放。
  // 声明先于 outboxDispatcher 启停块——token 周期清理需在其生命周期内调 startPruning。
  const widgetCredentialStore: WidgetCredentialStore | undefined = options.widgetJwtSecret
    ? createWidgetCredentialStore({ dbPath: options.dbPath })
    : undefined;
  const widgetAuth: WidgetAuthService | undefined =
    widgetCredentialStore && options.widgetJwtSecret
      ? createWidgetAuthService(options.widgetJwtSecret, widgetCredentialStore.ops)
      : undefined;
  const outboxDispatcher = new OutboxDispatcher(conversationStore, realtimeEvents);
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
    // widget token 周期清理跟随 outboxDispatcher 生命周期（同启用/禁用），避免 widget_tokens 无界增长。
    widgetCredentialStore?.startPruning();
  }
  const clientEvents = new DurableClientEventPublisher(conversationStore, outboxDispatcher);
  const permissionPolicy = new PermissionPolicyService();
  const agentConfig = new AgentConfigService({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService({ dataRoot: options.dataRoot, configPath: options.systemConfigPath });
  const mcp = new McpService({ dataRoot: options.dataRoot, configPath: options.mcpConfigPath });
  void mcp.autoConnectEnabledServers();
  agentConfig.setMcpService(mcp);
  const daemon = new DaemonService({ dataRoot: options.dataRoot, configPath: options.daemonConfigPath });
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
  // vectorStore 同一对象同时实现 IVectorStore(数据面) + IKnowledgeConfig(配置面),
  // 共享 knowledge.db 单一连接——主库 ragsystem.db 不再涉及向量/配置面。
  const vectorLibrary = new VectorLibraryService(modelAdapter, {
    vectorStore,
    knowledgeConfig: vectorStore,
    knowledgeFileStore: vectorStore,
  });
  const artifacts = new ArtifactService({ dataRoot: options.dataRoot });
  const embeddingModels = new EmbeddingModelService(vectorLibrary);
  const memoryStore = new MemoryStore({ dataRoot: options.dataRoot });
  const memoryTools = new MemoryToolService(memoryStore, conversationStore);
  const documentTools = new LocalDocumentToolService({ dataRoot: options.dataRoot, fileHistory });
  const backgroundTasks = new BackgroundTaskService();
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
  const taskTools = new TaskToolService(backgroundTasks, { dataRoot: options.dataRoot });
  const pendingInteractions = new PendingInteractionService(clientEvents);
  const hostToolRegistry = new HostToolRegistry();
  const delegationPending = new DelegationPendingService();
  // agentDelegation 需先实例化（工具依赖它），但其 runEngine/eventPublisher 延迟设置。
  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  const microcompactTtlSeconds = systemConfig.getMicrocompactTtlSeconds();
  // 上下文组装（memory + recent）由 createRuntime 经 extraContextSources 注入，TTL 经 systemConfig
  // 单一来源注入 run 路径。AgentContextService 仅保留预算估算（snapshot 已随 memory 迁出删除）。
  const agentContextService = new AgentContextService(systemConfig);
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
    vectorLibrary,
    mcp,
    codeExecutionTools,
    skillTools,
    getAgentDelegation: () => agentDelegation,
    agentConfig,
  };
  // 性能监控采集器:复用 conversationStore 的 metricOps(IMetricStore),供 AgentRunEngine 终态落库 + /metrics 读取。
  const metricsCollector = new AgentMetricsCollector(conversationStore);
  const agentExecution = createAgentExecutionService({
    sessions: sessionApplication,
    conversationStore,
    sdkStore,
    runtimeCore,
    dataRoot,
   toolsDeps,
   codeExecutionTools,
   taskTools,
   providersProvider: () => modelAdapter.listProviders(),
   backgroundTasks,
    fileIndex,
    outboxDispatcher,
    clientEvents,
    permissionPolicy,
    pendingInteractions,
    hostToolRegistry,
    delegationPending,
    logger: options.logger,
    microcompactTtlSeconds,
    metricsCollector,
    compressionService: new AgentCompressionService(
      conversationStore,
      () => modelAdapter.listProviders(),
      systemConfig,
    ),
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  agentDelegation.setRunEngine(() => agentExecution.runEngine);
  agentDelegation.setEventPublisher(() => agentExecution.eventPublisher);
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    outboxDispatcher.stop();
    widgetCredentialStore?.close();
    mcp.close();
    daemon.close();
    vectorLibrary.close();
    fileIndex.close();
    // conversation/file-index/vector 三个 store 各自开 SQLite 句柄（同 dbPath，WAL 允许多连接），
    // 各自需 close 释放文件句柄/WAL。conversationStore 是最底层（被 sessionApplication/outbox 等
    // 依赖），其上层已先关，故最后关。fileHistory/memoryStore 纯文件无句柄，无需 close。
    sdkStore.close();
    conversationStore.close();
  };
  return {
    conversationStore,
    sdkStore,
    sessionApplication,
    realtimeEvents,
    agentExecution,
    metricsCollector,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    daemon,
    fileHistory,
    fileIndex,
    vectorLibrary,
    artifacts,
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
    agentContextService,
    agentDelegation,
    outboxDispatcher,
    clientEvents,
    ...(widgetCredentialStore ? { widgetCredentialStore } : {}),
    ...(widgetAuth ? { widgetAuth } : {}),
    dataRoot,
    close,
  };
}
