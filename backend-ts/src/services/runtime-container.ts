import { AgentExecutionService } from "./agent-execution-service.js";
import { AgentSessionApplication } from "./agent-session-application.js";
import { CheckpointManager } from "./checkpoint-manager.js";
import { ConversationStore } from "./conversation-store.js";
import { InMemoryEventBus } from "./event-bus.js";
import { PermissionPolicyService } from "./permission-policy-service.js";

export interface RuntimeContainer {
  readonly conversationStore: ConversationStore;
  readonly sessionApplication: AgentSessionApplication;
  readonly checkpointManager: CheckpointManager;
  readonly events: InMemoryEventBus;
  readonly agentExecution: AgentExecutionService;
  readonly permissionPolicy: PermissionPolicyService;
}

export interface RuntimeContainerOptions {
  dbPath: string;
  checkpointDbPath?: string | undefined;
  dataRoot?: string | undefined;
}

export function createRuntimeContainer(options: RuntimeContainerOptions): RuntimeContainer {
  const conversationStore = new ConversationStore({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const sessionApplication = new AgentSessionApplication(conversationStore);
  const checkpointManager = new CheckpointManager({ dbPath: options.checkpointDbPath ?? options.dbPath });
  const events = new InMemoryEventBus();
  const agentExecution = new AgentExecutionService(sessionApplication, events);
  const permissionPolicy = new PermissionPolicyService();
  return {
    conversationStore,
    sessionApplication,
    checkpointManager,
    events,
    agentExecution,
    permissionPolicy,
  };
}
