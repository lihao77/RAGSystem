import type { ServerToClientEnvelope } from '@ragsystem/agent-protocol/wire';
import type { SessionMessage as ContractSessionMessage } from '@ragsystem/api-contracts';

export type OpenRecord = Record<string, any>;
export type SessionEnvelope = Omit<ServerToClientEnvelope, 'payload'> & OpenRecord & {
  type: ServerToClientEnvelope['type'];
  payload: OpenRecord;
  run_id?: string | null;
  call_id?: string;
  agent_id?: string;
  timestamp?: number | string;
};

export interface RefLike<T> {
  value: T;
}

export interface SessionMessage extends Omit<Partial<ContractSessionMessage>, 'role' | 'content' | 'metadata'>, OpenRecord {
  role: string;
  content: string;
  metadata: OpenRecord;
  attachments?: OpenRecord[];
  status?: OpenRecord[];
  finished?: boolean;
}

export interface ActiveRunState extends OpenRecord {
  active: boolean;
  assistantMsgIndex: number;
  runId: string | null;
  lastSeenSeq: number;
  isReplaying: boolean;
  phase: string;
  runStartedAt: number | null;
  waiting: OpenRecord | null;
}

export interface SessionClientDeps extends OpenRecord {
  createAssistantMessage: (metadata?: OpenRecord) => SessionMessage;
  cacheMessages: (sessionId: string, messages: SessionMessage[]) => void;
  deleteMessageCache: (sessionId: string) => void;
  loadSessionMessages: (sessionId: string, options?: OpenRecord) => any;
  scrollToBottom: (force?: boolean) => void;
  showToast: (...args: any[]) => void;
}

export interface RunRuntimeContext extends OpenRecord {
  resetInternal: () => void;
  observeDeliverySeq: (event: SessionEnvelope) => void;
  finalizeActiveRun: (sessionId: string) => void;
  terminalStatusFromEvent: (event: SessionEnvelope) => string;
}

export interface RunRecoveryContext {
  invalidateActiveStream: () => void;
  scheduleCommandFallback: (sessionId: string, messageIndex: number, timeout?: number) => void;
  clearCommandFallback: () => void;
  scheduleSessionResumeRecovery: (sessionId: string, timeout?: number) => void;
  clearSessionResumeRecovery: () => void;
}

export type InteractionResponse =
  | { kind: 'user_input'; value?: unknown }
  | { kind: 'approval'; approved?: boolean; message?: string };

export interface InteractionContext {
  respond: (interactionId: string, response: InteractionResponse) => Promise<void>;
  hasPending: (interactionId: string) => boolean;
  resolve: (interactionId: string) => boolean;
  reject: (interactionId: string, message?: string) => boolean;
  rememberRequired: (kind: string, interactionId: string) => boolean;
  reset: () => void;
}

export interface TaskStateContext {
  mergeExecutionObservability: (payload?: OpenRecord) => void;
  patchTaskInfo: (patch?: OpenRecord) => void;
  refreshSessionExecutionState: (sessionId: string, options?: OpenRecord) => Promise<void>;
  beginOptimisticExecutionState: (sessionId: string) => void;
}

export interface SessionStateContext {
  currentSessionId: RefLike<string | null>;
  messages: RefLike<SessionMessage[]>;
  isLoading: RefLike<boolean>;
  isCompressing: RefLike<boolean>;
  contextUsage: RefLike<OpenRecord>;
  llmRetryState: RefLike<OpenRecord | null>;
  activeRun: ActiveRunState;
}

export interface DispatcherOptions {
  deps: SessionClientDeps;
  state: SessionStateContext;
  runtime: RunRuntimeContext;
  recovery: RunRecoveryContext;
  interaction: InteractionContext;
  taskState: TaskStateContext;
  getStop: () => () => Promise<void>;
  takeFollowupCandidate: (requestId: string) => SessionMessage | null;
  bindUnassignedFollowupCandidates: (runId: string | null) => void;
}

export interface EventReducerOptions {
  deps: SessionClientDeps;
  runtime: RunRuntimeContext;
  activeRun: ActiveRunState;
  messages: RefLike<SessionMessage[]>;
  isCompressing: RefLike<boolean>;
  contextUsage: RefLike<OpenRecord>;
  llmRetryState: RefLike<OpenRecord | null>;
  patchTaskInfo: (patch?: OpenRecord) => void;
  handleApprovalRequired: (event: SessionEnvelope, data: OpenRecord, sessionId: string) => void;
  handleUserInputRequired: (event: SessionEnvelope, data: OpenRecord) => void;
}

export interface SessionCommandControllerOptions extends OpenRecord {
  deps: SessionClientDeps;
  currentSessionId: RefLike<string | null>;
  messages: RefLike<SessionMessage[]>;
  isLoading: RefLike<boolean>;
  contextUsage: RefLike<OpenRecord>;
  sessionTaskInfo: RefLike<OpenRecord | null>;
  activeRun: ActiveRunState;
  getSocket: () => WebSocket | null;
  mergeExecutionObservability: (payload?: OpenRecord) => void;
  beginOptimisticExecutionState: (sessionId: string) => void;
  scheduleCommandFallback: (sessionId: string, messageIndex: number, timeout?: number) => void;
  enqueueFollowupCandidate: (candidate: SessionMessage) => void;
  markFollowupCandidateFailed: (requestId: string, error: string) => void;
}

export interface SessionRunRecoveryOptions extends OpenRecord {
  getCurrentSessionId: () => string | null;
  activeRun: ActiveRunState;
  messages: RefLike<SessionMessage[]>;
  isLoading: RefLike<boolean>;
  deleteMessageCache: (sessionId: string) => void;
  loadSessionMessages: (sessionId: string, options?: OpenRecord) => any;
  refreshSessionExecutionState: (sessionId: string, options?: OpenRecord) => Promise<void>;
}

export interface SessionTransportOptions {
  getCurrentSessionId: () => string | null;
  onEnvelope: (event: SessionEnvelope, sessionId: string) => void;
  onDisconnect?: () => void;
  onSocketClose?: () => void;
  onReconnectExhausted?: (sessionId: string) => void;
  issueTicket?: (sessionId: string) => Promise<any>;
  createSocket?: (url: string) => WebSocket;
  maxReconnectAttempts?: number;
}

export interface SessionInteractionControllerOptions {
  getCurrentSessionId: () => string;
  getSocket: () => WebSocket | null;
  respondHttp?: (sessionId: string, interactionId: string, body: InteractionResponse) => Promise<any>;
  ackTimeoutMs?: number;
}

export interface SessionTaskStateOptions {
  currentSessionId: RefLike<string | null>;
  sessionTaskInfo: RefLike<OpenRecord | null>;
  sessionExecutionObservability: RefLike<OpenRecord | null>;
  fetchTaskStatus?: (sessionId: string) => Promise<any>;
  warn?: (...args: any[]) => void;
}
