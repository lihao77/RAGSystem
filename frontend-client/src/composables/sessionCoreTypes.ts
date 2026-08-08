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

export interface SessionMessage extends Omit<Partial<ContractSessionMessage>, 'role' | 'content' | 'content_parts' | 'metadata'>, OpenRecord {
  role: string;
  content: string;
  content_parts: OpenRecord[];
  metadata: OpenRecord;
  attachments?: OpenRecord[];
  status?: OpenRecord[];
  finished?: boolean;
}

export interface ActiveRunState extends OpenRecord {
  active: boolean;
  assistantMsgIndex: number;
  runId: string | null;
  rootCallId: string | null;
  lastSeenSeq: number;
  isReplaying: boolean;
  phase: string;
  runningToolCalls: Record<string, OpenRecord>;
  runningModelCalls: Record<string, OpenRecord>;
  runStartedAt: number | null;
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
}

export type InteractionResponse =
  | { kind: 'user_input'; value?: unknown }
  | { kind: 'approval'; approved?: boolean; message?: string };

export interface InteractionContext {
  respond: (interactionId: string, response: InteractionResponse) => Promise<void>;
  hasPending: (interactionId: string) => boolean;
  resolve: (interactionId: string) => boolean;
  reject: (interactionId: string, message?: string) => boolean;
  reset: () => void;
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
  applySessionRuntime: (snapshot: OpenRecord) => void;
  finishOptimisticCommand: () => void;
  onRuntimeSnapshot?: (sessionId: string, snapshot: OpenRecord) => void;
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
  handleApprovalRequired: (event: SessionEnvelope, data: OpenRecord, sessionId: string) => void;
  handleUserInputRequired: (event: SessionEnvelope, data: OpenRecord) => void;
}

export interface SessionCommandControllerOptions extends OpenRecord {
  deps: SessionClientDeps;
  currentSessionId: RefLike<string | null>;
  messages: RefLike<SessionMessage[]>;
  isLoading: RefLike<boolean>;
  contextUsage: RefLike<OpenRecord>;
  activeRun: ActiveRunState;
  allowsRuntimeAction: (action: string) => boolean;
  getSessionRuntime: () => OpenRecord | null;
  beginOptimisticCommand: (kind?: string) => void;
  finishOptimisticCommand: () => void;
  scheduleCommandFallback: (sessionId: string, messageIndex: number, timeout?: number) => void;
  enqueueFollowupCandidate: (candidate: SessionMessage) => void;
  markFollowupCandidateFailed: (requestId: string, error: string) => void;
  sendViaSdk: (input: OpenRecord, requestId: string) => Promise<OpenRecord>;
  stopViaSdk: (sessionId: string) => Promise<void>;
}

export interface SessionRunRecoveryOptions extends OpenRecord {
  activeRun: ActiveRunState;
  messages: RefLike<SessionMessage[]>;
  isLoading: RefLike<boolean>;
  deleteMessageCache: (sessionId: string) => void;
  loadSessionMessages: (sessionId: string, options?: OpenRecord) => any;
  finishOptimisticCommand: () => void;
}

export interface SessionInteractionControllerOptions {
  getSessionRuntime: () => OpenRecord | null;
  respondViaSdk: (interactionId: string, response: InteractionResponse) => Promise<void>;
}
