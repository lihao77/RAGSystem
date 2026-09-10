import type { MessageRequestStatusPort } from '../../contracts/session/message-request-status.js';
import type { AgentRunStartResult } from '../../contracts/execution/execution.js';

/** Persist receipt before invoking code that can ACK, and persist outcome before notifying the socket. */
export async function trackMessageRequest(
  store: MessageRequestStatusPort,
  input: { sessionId: string; requestId: string; content: string },
  start: () => Promise<AgentRunStartResult>,
): Promise<AgentRunStartResult> {
  const { sessionId, requestId, content } = input;
  const inserted = await store.beginMessageRequest(sessionId, requestId, content);
  if (!inserted) {
    const previous = (await store.listMessageRequestStatuses(sessionId, [requestId])).find(item => item.request_id === requestId);
    return {
      started: previous?.status === 'processing' || previous?.status === 'queued' || previous?.status === 'consumed',
      session_id: sessionId,
      request_id: requestId,
      ...(previous?.status === 'failed' ? { error: previous.error || '发送失败' } : {}),
    };
  }
  let result: AgentRunStartResult;
  const heartbeat = setInterval(() => {
    void store.renewMessageRequest(sessionId, requestId).catch(() => undefined);
  }, 30_000);
  heartbeat.unref?.();
  try {
    result = await start();
  } catch (error) {
    await store.settleMessageRequest(sessionId, requestId, 'failed', error instanceof Error ? error.message : '发送失败');
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
  const accepted = result.started || result.kind === 'command';
  await store.settleMessageRequest(sessionId, requestId,
    accepted ? (result.kind === 'command' ? 'consumed' : 'queued') : 'failed',
    accepted ? null : result.error ?? 'Agent stream 未启动');
  return result;
}
