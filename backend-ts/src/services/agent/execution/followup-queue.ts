import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import { renderSemanticBlock } from "../kernel-plugins/protocol/xml/index.js";

/**
 * 按会话累积"运行中追加的 followup 消息"，在下一轮 runMinimalAgent 取回话时排空。
 * 替代原 AgentExecutionService.pendingFollowupsBySession Map + queueFollowup/drainFollowups。
 */
export class FollowupQueue {
  private readonly pendingBySession = new Map<string, ChatMessage[]>();

  queue(sessionId: string, content: string): void {
    const followups = this.pendingBySession.get(sessionId) ?? [];
    followups.push({
      role: "user",
      content: renderSemanticBlock("user_followup", content, { source: "running_session" }),
    });
    this.pendingBySession.set(sessionId, followups);
  }

  drain(sessionId: string): ChatMessage[] {
    const followups = this.pendingBySession.get(sessionId);
    if (!followups?.length) {
      return [];
    }
    this.pendingBySession.delete(sessionId);
    return followups.map((message) => ({ ...message }));
  }
}
