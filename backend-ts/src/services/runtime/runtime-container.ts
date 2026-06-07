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
import { FileIndexService } from "../stores/file-index-service.js";
import { InMemoryEventBus } from "./event-bus.js";
import { LocalBashToolService } from "../tools/local-bash-tool-service.js";
import { LocalDocumentToolService } from "../tools/local-document-tool-service.js";
import { OpenAiCompatibleChatClient, type LlmChatClient } from "../integrations/llm-chat-client.js";
import { MemoryStore } from "../stores/memory-store.js";
import { MemoryToolService } from "../tools/memory-tool-service.js";
import { McpService } from "../integrations/mcp-service.js";
import { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { PendingInteractionService } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";
import { RuntimeCoreService } from "./runtime-core-service.js";
import { RuntimeToolBridge } from "./runtime-tool-bridge.js";
import { SystemConfigService } from "../config/system-config-service.js";
import { TaskToolService } from "../tools/task-tool-service.js";
import { VectorLibraryService } from "../knowledge/vector-library-service.js";
import { OutboxDispatcher } from "./event-outbox/dispatcher.js";
import { DurableClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import {
  DEFAULT_TERMINAL_EVENT_DELIVERY_MODE,
  type TerminalEventDeliveryMode,
} from "./event-delivery-mode.js";

export interface RuntimeContainer {
  readonly conversationStore: ConversationStore;
  readonly sessionApplication: AgentSessionApplication;
  readonly checkpointManager: CheckpointManager;
  readonly events: InMemoryEventBus;
  readonly agentExecution: AgentExecutionService;
  readonly permissionPolicy: PermissionPolicyService;
  readonly agentConfig: AgentConfigService;
  readonly modelAdapter: ModelAdapterService;
  readonly systemConfig: SystemConfigService;
  readonly mcp: McpService;
  readonly daemon: DaemonService;
  readonly fileIndex: FileIndexService;
  readonly vectorLibrary: VectorLibraryService;
  readonly artifacts: ArtifactService;
  readonly embeddingModels: EmbeddingModelService;
  readonly memoryStore: MemoryStore;
  readonly memoryTools: MemoryToolService;
  readonly documentTools: LocalDocumentToolService;
  readonly bashTools: LocalBashToolService;
  readonly backgroundTasks: BackgroundTaskService;
  readonly taskTools: TaskToolService;
  readonly pendingInteractions: PendingInteractionService;
  readonly runtimeToolBridge: RuntimeToolBridge;
  readonly runtimeCore: RuntimeCoreService;
  readonly agentRuntimeCore: AgentRuntimeCore;
  readonly agentRuntimeContextBuilder: AgentRuntimeContextBuilder;
  readonly contextCompression: AgentContextCompressionService;
  readonly agentDelegation: AgentDelegationService;
  readonly outboxDispatcher: OutboxDispatcher;
  readonly clientEvents: DurableClientEventPublisher;
  readonly terminalEventDelivery: TerminalEventDeliveryMode;
  close(): void;
}

export interface RuntimeContainerOptions {
  dbPath: string;
  checkpointDbPath?: string | undefined;
  dataRoot?: string | undefined;
  llmChatClient?: LlmChatClient | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
  terminalEventDelivery?: TerminalEventDeliveryMode | undefined;
  startOutboxDispatcher?: boolean | undefined;
  outboxDispatcherIntervalMs?: number | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const conversationStore = new ConversationStore({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const sessionApplication = new AgentSessionApplication(conversationStore);
  const checkpointManager = new CheckpointManager({ dbPath: options.checkpointDbPath ?? options.dbPath });
  const events = new InMemoryEventBus();
  const terminalEventDelivery = options.terminalEventDelivery ?? DEFAULT_TERMINAL_EVENT_DELIVERY_MODE;
  const outboxDispatcher = new OutboxDispatcher(
    conversationStore,
    events,
    undefined,
    terminalEventDelivery === "outbox_live" ? "live" : "shadow",
  );
  if (options.startOutboxDispatcher ?? terminalEventDelivery === "outbox_live") {
    outboxDispatcher.start(options.outboxDispatcherIntervalMs);
  }
  const clientEvents = new DurableClientEventPublisher(
    conversationStore,
    events,
    outboxDispatcher,
    terminalEventDelivery,
  );
  const permissionPolicy = new PermissionPolicyService();
  const agentConfig = new AgentConfigService({ dataRoot: options.dataRoot, configRoot: options.agentConfigRoot });
  const modelAdapter = new ModelAdapterService({
    dataRoot: options.dataRoot,
    providersConfigPath: options.modelAdapterProvidersConfigPath,
  });
  const systemConfig = new SystemConfigService();
  const mcp = new McpService();
  const daemon = new DaemonService();
  const fileIndex = new FileIndexService({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const vectorLibrary = new VectorLibraryService(fileIndex, modelAdapter);
  const artifacts = new ArtifactService({ dataRoot: options.dataRoot });
  const embeddingModels = new EmbeddingModelService(vectorLibrary);
  const memoryStore = new MemoryStore({ dataRoot: options.dataRoot });
  const memoryTools = new MemoryToolService(memoryStore, conversationStore);
  const documentTools = new LocalDocumentToolService({ dataRoot: options.dataRoot });
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
  const runtimeToolBridge = new RuntimeToolBridge(memoryTools, pendingInteractions, permissionPolicy, documentTools, bashTools, taskTools);
  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const llmChatClient = options.llmChatClient ?? new OpenAiCompatibleChatClient();
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
    events,
    conversationStore,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
    runtimeToolBridge,
    contextCompression,
    agentConfig,
    backgroundTasks,
    {
      terminalEventDelivery,
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
  };
  return {
    conversationStore,
    sessionApplication,
    checkpointManager,
    events,
    agentExecution,
    permissionPolicy,
    agentConfig,
    modelAdapter,
    systemConfig,
    mcp,
    daemon,
    fileIndex,
    vectorLibrary,
    artifacts,
    embeddingModels,
    memoryStore,
    memoryTools,
    documentTools,
    bashTools,
    backgroundTasks,
    taskTools,
    pendingInteractions,
    runtimeToolBridge,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
    contextCompression,
    agentDelegation,
    outboxDispatcher,
    clientEvents,
    terminalEventDelivery,
    close,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
