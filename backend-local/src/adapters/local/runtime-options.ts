import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { AgentExecutionLogger } from "@ragsystem/backend-core/services/agent/execution/index.js";
import type { AsyncBackgroundTaskRepository } from "@ragsystem/backend-core/contracts/storage/background-task-repository.js";
import type { AgentMailboxStorePort } from "@ragsystem/backend-core/contracts/storage/agent-mailbox-repository.js";
import type { RealtimeEventBus } from "@ragsystem/backend-core/contracts/runtime/realtime-event-bus.js";
import type { ClientEventPublisherPort } from "@ragsystem/backend-core/contracts/runtime/core-runtime-ports.js";
import type { ExecutionStorage } from "@ragsystem/backend-core/contracts/execution/execution-storage.js";
import type { PathAccessPolicy } from "@ragsystem/backend-core/contracts/runtime/path-access-policy.js";
import type { RuntimeStorage } from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import type { AgentSessionApplication } from "@ragsystem/backend-core/services/sessions/index.js";
import type { BackendRuntimeContributions } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { ConversationStore } from "./sqlite/conversation-store/index.js";

export interface LocalRuntimeInfrastructure {
  conversationStore: ConversationStore;
  agentMailbox: AgentMailboxStorePort;
  sessions: AgentSessionApplication;
}

export interface LocalRuntimeContainerOptions {
  tenantId: TenantId;
  dbPath: string;
  dataRoot?: string;
  logger?: AgentExecutionLogger;
  modelAdapterProvidersConfigPath?: string;
  systemConfigPath?: string;
  agentConfigRoot?: string;
  startOutboxDispatcher?: boolean;
  outboxDispatcherIntervalMs?: number;
  hooks?: (registry: HookRegistry) => void;
  plugins?: BackendRuntimeContributions;
  clientEventsFactory?: (
    tenantId: TenantId,
    realtimeEvents: RealtimeEventBus,
    runtimeStorage: RuntimeStorage,
  ) => ClientEventPublisherPort;
  asyncBackgroundTasks?: AsyncBackgroundTaskRepository;
  executionStorage?: ExecutionStorage;
  runtimeStorageFactory?: (tenantId: TenantId) => RuntimeStorage;
  executionStorageFactory?: (input: { tenantId: TenantId; runtimeStorage: RuntimeStorage; clientEvents: ClientEventPublisherPort }) => ExecutionStorage;
  hostToolsEnabled?: boolean;
  pathAccessPolicyFactory?: () => PathAccessPolicy;
  /** Composition observer for diagnostics and test fixtures; infrastructure is not exposed on RuntimeContainer. */
  onInfrastructureCreated?: (infrastructure: LocalRuntimeInfrastructure) => void;
}

export type RuntimeContainerOptions = LocalRuntimeContainerOptions;
