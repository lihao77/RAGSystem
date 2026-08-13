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
  scheduleCommandFallback: (sessionId: string, timeout?: number) => void;
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
  finishPendingCommand: (requestId?: string | null) => void;
  reorderMessages: () => SessionMessage[];
  onRuntimeSnapshot?: (sessionId: string, snapshot: OpenRecord) => void;
  getStop: () => () => Promise<void>;
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
  isLoading: RefLike<boolean>;
  allowsRuntimeAction: (action: string) => boolean;
  getSessionRuntime: () => OpenRecord | null;
  beginPendingCommand: (kind?: string, requestId?: string | null) => void;
  finishPendingCommand: (requestId?: string | null) => void;
  scheduleCommandFallback: (sessionId: string, timeout?: number) => void;
  sendViaSdk: (input: OpenRecord, requestId: string) => Promise<OpenRecord>;
  stopViaSdk: (sessionId: string) => Promise<void>;
}

export interface SessionRunRecoveryOptions extends OpenRecord {
  activeRun: ActiveRunState;
  isLoading: RefLike<boolean>;
  deleteMessageCache: (sessionId: string) => void;
  loadSessionMessages: (sessionId: string, options?: OpenRecord) => any;
  finishPendingCommand: (requestId?: string | null) => void;
}

export interface SessionInteractionControllerOptions {
  getSessionRuntime: () => OpenRecord | null;
  respondViaSdk: (interactionId: string, response: InteractionResponse) => Promise<void>;
}
