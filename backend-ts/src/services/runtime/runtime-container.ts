import { AgentExecutionService } from "../agent/agent-execution-service.js";
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
import { CheckpointManager } from "../stores/checkpoint-manager.js";
import { ConversationStore } from "../stores/conversation-store.js";
import { DaemonService } from "../daemon/daemon-service.js";
import { EmbeddingModelService } from "../knowledge/embedding-model-service.js";
import { FileHistoryService } from "../stores/file-history-service.js";
import { FileIndexService } from "../stores/file-index-service.js";
import { RealtimeEventHub } from "./realtime-event-hub.js";
import { LocalBashToolService } from "../tools/local-bash-tool-service.js";
import { CodeExecutionToolService } from "../tools/code-execution-tool-service.js";
import { LocalDocumentToolService } from "../tools/local-document-tool-service.js";
import { LocalSearchToolService } from "../tools/local-search-tool-service.js";
import { OpenAiCompatibleChatClient, type LlmChatClient } from "../integrations/llm-chat-client.js";
import { MemoryStore } from "../stores/memory-store.js";
import { MemoryToolService } from "../tools/memory-tool-service.js";
import { McpService } from "../integrations/mcp-service.js";
import { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { PendingInteractionService } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";
import { RuntimeCoreService } from "./runtime-core-service.js";
import { RuntimeToolBridge } from "./runtime-tool-bridge.js";
import { HookRuntimeService, type WorkspaceTrustConfig } from "./hooks/index.js";
import { SystemConfigService } from "../config/system-config-service.js";
import { TaskToolService } from "../tools/task-tool-service.js";
import { VectorLibraryService } from "../knowledge/vector-library-service.js";
import { OutboxDispatcher } from "./event-outbox/dispatcher.js";
import { DurableClientEventPublisher } from "./event-outbox/client-event-publisher.js";

export interface RuntimeContainer {
  readonly conversationStore: ConversationStore;
  readonly sessionApplication: AgentSessionApplication;
  readonly checkpointManager: CheckpointManager;
  readonly realtimeEvents: RealtimeEventHub;
  readonly agentExecution: AgentExecutionService;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly mcp: McpService;
  readonly daemon: DaemonService;
  readonly fileHistory: FileHistoryService;
  readonly fileIndex: FileIndexService;
  readonly vectorLibrary: VectorLibraryService;
  readonly artifacts: ArtifactService;
  readonly embeddingModels: EmbeddingModelService;
  readonly memoryStore: MemoryStore;
  readonly memoryTools: MemoryToolService;
  readonly documentTools: LocalDocumentToolService;
  readonly codeExecutionTools: CodeExecutionToolService;
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
  checkpointDbPath?: string | undefined;
  dataRoot?: string | undefined;
  llmChatClient?: LlmChatClient | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  mcpConfigPath?: string | undefined;
  daemonConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
  startOutboxDispatcher?: boolean | undefined;
  outboxDispatcherIntervalMs?: number | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const conversationStore = new ConversationStore({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const fileHistory = new FileHistoryService({ dataRoot: options.dataRoot });
  const sessionApplication = new AgentSessionApplication(conversationStore, fileHistory);
  const checkpointManager = new CheckpointManager({ dbPath: options.checkpointDbPath ?? options.dbPath });
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
  const systemConfig = new SystemConfigService();
  const mcp = new McpService({ dataRoot: options.dataRoot, configPath: options.mcpConfigPath });
  const daemon = new DaemonService({ dataRoot: options.dataRoot, configPath: options.daemonConfigPath });
  const fileIndex = new FileIndexService({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const vectorLibrary = new VectorLibraryService(fileIndex, modelAdapter, {
    dbPath: options.dbPath,
    dataRoot: options.dataRoot,
  });
  const artifacts = new ArtifactService({ dataRoot: options.dataRoot });
  const embeddingModels = new EmbeddingModelService(vectorLibrary);
  const memoryStore = new MemoryStore({ dataRoot: options.dataRoot });
  const memoryTools = new MemoryToolService(memoryStore, conversationStore);
  const documentTools = new LocalDocumentToolService({ dataRoot: options.dataRoot, fileHistory });
  const codeExecutionTools = new CodeExecutionToolService({ dataRoot: options.dataRoot });
  const searchTools = new LocalSearchToolService({ dataRoot: options.dataRoot });
  const backgroundTasks = new BackgroundTaskService();
  const toolsConfig = asRecord(systemConfig.getConfig().tools);
  const bashTools = new LocalBashToolService({
    dataRoot: options.dataRoot,
    defaultTimeoutSeconds: asNumber(toolsConfig?.bash_default_timeout),
    maxTimeoutSeconds: asNumber(toolsConfig?.bash_max_timeout),
    maxOutputChars: asNumber(toolsConfig?.bash_max_output),
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
  );
  codeExecutionTools.setRuntimeTools(runtimeToolBridge);
  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const agentRuntimeCore = new AgentRuntimeCore(llmChatClient, { dataRoot: options.dataRoot });
  const contextCompression = new AgentContextCompressionService(conversationStore, llmChatClient, systemConfig);
  const agentRuntimeContextBuilder = new AgentRuntimeContextBuilder([
    new MemoryIndexContextSource(conversationStore, { memoryStore }),
    new RecentMessagesContextSource(conversationStore),
  ]);
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
  const agentExecution = new AgentExecutionService(
    sessionApplication,
    conversationStore,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
    runtimeToolBridge,
    contextCompression,
    agentConfig,
    backgroundTasks,
    fileIndex,
    {
      outboxDispatcher,
      clientEvents,
    },
  );
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
  };
  return {
    conversationStore,
    sessionApplication,
    checkpointManager,
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
