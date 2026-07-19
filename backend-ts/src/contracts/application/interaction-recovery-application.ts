import type { ProviderContinuationRecord } from "../conversation-store/index.js";
import type { InteractionKind } from "../interactions.js";

export interface InteractionRecoveryResult {
  resolved: boolean;
  needsResume: boolean;
  kind: InteractionKind;
  interactionId: string;
  rootRunId?: string | undefined;
  approvalId?: string | undefined;
  toolCallId?: string | undefined;
  approved?: boolean | undefined;
  message?: string | undefined;
  error?: string | undefined;
}

export interface InteractionRecoveryApplication {
  respondApproval(
    sessionId: string,
    interactionId: string,
    resolution: { approved: boolean; message: string },
  ): Promise<InteractionRecoveryResult>;
  respondUserInput(
    sessionId: string,
    interactionId: string,
    resolution: { value: string },
  ): Promise<InteractionRecoveryResult>;
  getProviderContinuation(
    sessionId: string,
    messageId: string,
  ): Promise<ProviderContinuationRecord | null>;
}
