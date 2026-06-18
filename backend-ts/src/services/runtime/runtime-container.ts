import { createAgentExecutionService, type AgentExecutionService } from "../agent/agent-execution-service/index.js";
import type { AgentExecutionLogger } from "../agent/agent-execution-service/index.js";
import { AgentContextCompressionService } from "../agent/agent-context-compression-service.js";
import { AgentDelegationService } from "../agent/agent-delegation-service.js";
import {
  AgentRuntimeContextBuilder,
  MemoryIndexContextSource,
  RecentMessagesContextSource,
} from "../agent/agent-runtime-context-builder.js";
import { AgentRuntimeCore } from "../agent/agent-runtime-core.js";
import { BackgroundTaskService } from "./background-task-service.js";
import { AgentConfigService } from "../agent/agent-config-service.js";
import { AgentSessionApplication } from "../agent/agent-session-application.js";
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
import { OpenAiCompatibleChatClient, type LlmChatClient } from "../integrations/llm-chat-client.js";
import { MemoryStore } from "../stores/memory-store.js";
import { MemoryToolService } from "../../tools/MemoryTools/MemoryExecution.js";
import { McpService } from "../integrations/mcp-service.js";
import { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { PendingInteractionService } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";
import { RuntimeCoreService } from "./runtime-core-service.js";
import { RuntimeToolBridge } from "./runtime-tool-bridge.js";
import { HookRuntimeService, type WorkspaceTrustConfig } from "./hooks/index.js";
import { SystemConfigService } from "../config/system-config-service.js";
import { TaskToolService } from "../../tools/TaskTools/TaskExecution.js";
import { VectorLibraryService } from "../knowledge/vector-library-service.js";
import { createVectorStoreFromConfig } from "../vector-store/vector-store-factory.js";
import type { IVectorStore } from "../../contracts/vector-store/index.js";
import { OutboxDispatcher } from "./event-outbox/dispatcher.js";
import { DurableClientEventPublisher } from "./event-outbox/client-event-publisher.js";

export interface RuntimeContainer {
  readonly conversationStore: ConversationStore;
  readonly sessionApplication: AgentSessionApplication;
  readonly realtimeEvents: RealtimeEventHub;
  readonly agentExecution: AgentExecutionService;
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
  readonly searchTools: LocalSearchToolService;
  readonly bashTools: LocalBashToolService;
  readonly backgroundTasks: BackgroundTaskService;
  readonly taskTools: TaskToolService;
  readonly pendingInteractions: PendingInteractionService;
  readonly hooks: HookRuntimeService;
  readonly runtimeToolBridge: RuntimeToolBridge;
  readonly runtimeCore: RuntimeCoreService;
  readonly agentRuntimeCore: AgentRuntimeCore;
  readonly agentRuntimeContextBuilder: AgentRuntimeContextBuilder;
  readonly contextCompression: AgentContextCompressionService;
  readonly agentDelegation: AgentDelegationService;
  readonly outboxDispatcher: OutboxDispatcher;
  readonly clientEvents: DurableClientEventPublisher;
  close(): void;
}

export interface RuntimeContainerOptions {
  dbPath: string;
  dataRoot?: string | undefined;
  logger?: AgentExecutionLogger | undefined;
  llmChatClient?: LlmChatClient | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  mcpConfigPath?: string | undefined;
  daemonConfigPath?: string | undefined;
  systemConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
  startOutboxDispatcher?: boolean | undefined;
  outboxDispatcherIntervalMs?: number | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const conversationStore = createConversationStore({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const fileHistory = new FileHistoryService({ dataRoot: options.dataRoot });
  const sessionApplication = new AgentSessionApplication(conversationStore, fileHistory);
  const realtimeEvents = new RealtimeEventHub();
  const outboxDispatcher = new OutboxDispatcher(conversationStore, realtimeEvents);
  if (options.startOutboxDispatcher ?? true) {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  const clientEvents = new DurableClientEventPublisher(conversationStore, outboxDispatcher);
  const permissionPolicy = new PermissionPolicyService();
  const llmChatClient = options.llmChatClient ?? new OpenAiCompatibleChatClient();
  const agentConfig = new AgentConfigService({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
    chatClient: llmChatClient,
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
  const hooksConfig = asRecord(systemConfig.getConfig().hooks);
  const hooks = new HookRuntimeService({
    enabled: hooksConfig?.enabled !== false,
    workspaceTrust: parseWorkspaceTrustConfig(asRecord(hooksConfig?.workspace_trust)),
  });
  const runtimeToolBridge = new RuntimeToolBridge(
    memoryTools,
    pendingInteractions,
    permissionPolicy,
    documentTools,
    bashTools,
    taskTools,
    searchTools,
    hooks,
    vectorLibrary,
    mcp,
    codeExecutionTools,
    skillTools,
  );
  codeExecutionTools.setRuntimeTools(runtimeToolBridge);
  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const agentRuntimeCore = new AgentRuntimeCore(llmChatClient, { dataRoot: options.dataRoot });
  const contextCompression = new AgentContextCompressionService(conversationStore, llmChatClient, systemConfig);
  const memoryConfig = systemConfig.getMemoryConfig();
  const agentRuntimeContextBuilder = new AgentRuntimeContextBuilder([
    new MemoryIndexContextSource(conversationStore, {
      memoryStore,
      indexMaxLines: memoryConfig.index_max_lines,
      indexMaxChars: memoryConfig.index_max_chars,
    }),
    new RecentMessagesContextSource(conversationStore),
  ], { systemConfig });
  const agentDelegation = new AgentDelegationService(
    conversationStore,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
    clientEvents,
    agentConfig,
  );
  agentDelegation.setRuntimeToolsProvider(() => runtimeToolBridge);
  runtimeToolBridge.setAgentDelegation(agentDelegation);
  const agentExecution = createAgentExecutionService({
    sessions: sessionApplication,
    conversationStore,
    runtimeCore,
    agentRuntimeCore,
    contextBuilder: agentRuntimeContextBuilder,
    runtimeTools: runtimeToolBridge,
    contextCompression,
    promptConfigResolver: agentConfig,
    backgroundTasks,
    fileIndex,
    outboxDispatcher,
    clientEvents,
    logger: options.logger,
  });
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    outboxDispatcher.stop();
    mcp.close();
    daemon.close();
    vectorLibrary.close();
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
    searchTools,
    bashTools,
    backgroundTasks,
    taskTools,
    pendingInteractions,
    hooks,
    runtimeToolBridge,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
    contextCompression,
    agentDelegation,
    outboxDispatcher,
    clientEvents,
    close,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseWorkspaceTrustConfig(value: Record<string, unknown> | null): WorkspaceTrustConfig | null {
  if (!value) {
    return null;
  }
  const rules = Array.isArray(value.rules)
    ? value.rules
        .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const matcher = asRecord(item.matcher);
          return {
            workspaceRootPrefix: asString(item.workspace_root_prefix) ?? asString(matcher?.workspace_root_prefix) ?? "",
            trust: asString(item.trust) === "untrusted" ? "untrusted" as const : "trusted" as const,
          };
        })
    : [];
  return {
    default: asString(value.default) === "untrusted" ? "untrusted" : "trusted",
    rules,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
