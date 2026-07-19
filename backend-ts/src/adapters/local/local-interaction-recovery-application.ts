import type { InteractionRecoveryApplication, InteractionRecoveryResult } from "../../contracts/interaction-recovery-application.js";
import type { ConversationStore, ProviderContinuationRecord } from "../../contracts/conversation-store/index.js";
import type { PendingInteractionService } from "../../services/runtime/pending-interaction-service.js";

export class LocalInteractionRecoveryApplication implements InteractionRecoveryApplication {
  constructor(
    private readonly pendingInteractions: Pick<PendingInteractionService, "respondApproval" | "respondUserInput">,
    private readonly conversations: Pick<ConversationStore, "getProviderContinuation">,
  ) {}

  async respondApproval(
    sessionId: string,
    interactionId: string,
    resolution: { approved: boolean; message: string },
  ): Promise<InteractionRecoveryResult> {
    return this.pendingInteractions.respondApproval(sessionId, interactionId, resolution);
  }

  async respondUserInput(
    sessionId: string,
    interactionId: string,
    resolution: { value: string },
  ): Promise<InteractionRecoveryResult> {
    return this.pendingInteractions.respondUserInput(sessionId, interactionId, resolution);
  }

  async getProviderContinuation(
    sessionId: string,
    messageId: string,
  ): Promise<ProviderContinuationRecord | null> {
    return this.conversations.getProviderContinuation(sessionId, messageId);
  }
}
