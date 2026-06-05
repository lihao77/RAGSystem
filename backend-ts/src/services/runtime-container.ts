import { AgentExecutionService } from "./agent-execution-service.js";
import {
  AgentRuntimeContextBuilder,
  MemoryIndexContextSource,
  RecentMessagesContextSource,
} from "./agent-runtime-context-builder.js";
import { AgentRuntimeCore } from "./agent-runtime-core.js";
import { AgentConfigService } from "./agent-config-service.js";
import { AgentSessionApplication } from "./agent-session-application.js";
import { ArtifactService } from "./artifact-service.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { ConversationStore } from "./conversation-store.js";
import { DaemonService } from "./daemon-service.js";
import { EmbeddingModelService } from "./embedding-model-service.js";
import { FileIndexService } from "./file-index-service.js";
import { InMemoryEventBus } from "./event-bus.js";
import { OpenAiCompatibleChatClient, type LlmChatClient } from "./llm-chat-client.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryToolService } from "./memory-tool-service.js";
import { McpService } from "./mcp-service.js";
import { ModelAdapterService } from "./model-adapter-service.js";
import { PendingInteractionService } from "./pending-interaction-service.js";
import { PermissionPolicyService } from "./permission-policy-service.js";
import { RuntimeCoreService } from "./runtime-core-service.js";
import { RuntimeToolBridge } from "./runtime-tool-bridge.js";
import { SystemConfigService } from "./system-config-service.js";
import { VectorLibraryService } from "./vector-library-service.js";

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
  readonly pendingInteractions: PendingInteractionService;
  readonly runtimeToolBridge: RuntimeToolBridge;
  readonly runtimeCore: RuntimeCoreService;
  readonly agentRuntimeCore: AgentRuntimeCore;
  readonly agentRuntimeContextBuilder: AgentRuntimeContextBuilder;
}

export interface RuntimeContainerOptions {
  dbPath: string;
  checkpointDbPath?: string | undefined;
  dataRoot?: string | undefined;
  llmChatClient?: LlmChatClient | undefined;
  modelAdapterProvidersConfigPath?: string | undefined;
  agentConfigRoot?: string | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const conversationStore = new ConversationStore({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const sessionApplication = new AgentSessionApplication(conversationStore);
  const checkpointManager = new CheckpointManager({ dbPath: options.checkpointDbPath ?? options.dbPath });
  const events = new InMemoryEventBus();
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
  const pendingInteractions = new PendingInteractionService(events);
  const runtimeToolBridge = new RuntimeToolBridge(memoryTools, pendingInteractions);
  const runtimeCore = new RuntimeCoreService(agentConfig, modelAdapter);
  const llmChatClient = options.llmChatClient ?? new OpenAiCompatibleChatClient();
  const agentRuntimeCore = new AgentRuntimeCore(llmChatClient);
  const agentRuntimeContextBuilder = new AgentRuntimeContextBuilder([
    new MemoryIndexContextSource(conversationStore, { memoryStore }),
    new RecentMessagesContextSource(conversationStore),
  ]);
  const agentExecution = new AgentExecutionService(
    sessionApplication,
    events,
    conversationStore,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
    runtimeToolBridge,
  );
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
    pendingInteractions,
    runtimeToolBridge,
    runtimeCore,
    agentRuntimeCore,
    agentRuntimeContextBuilder,
  };
}
