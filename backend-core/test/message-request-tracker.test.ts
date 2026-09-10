import { describe, expect, it, vi } from 'vitest';
import { trackMessageRequest } from '../src/services/sessions/message-request-tracker.js';
import { hydrateMessageRequestStatus, type MessageRequestStatusPort } from '../src/contracts/session/message-request-status.js';

describe('durable send receipts', () => {
  const input = { sessionId: 'session-1', requestId: 'req-1', content: 'follow up' };
  const harness = () => ({
    beginMessageRequest: vi.fn(async () => true),
    renewMessageRequest: vi.fn(async () => {}),
    settleMessageRequest: vi.fn(async () => {}),
    listMessageRequestStatuses: vi.fn(async () => []),
  } satisfies MessageRequestStatusPort);

  it('stores receipt before the early ACK and records asynchronous failures without the socket', async () => {
    const store = harness();
    let rejectStart!: (error: Error) => void;
    const start = vi.fn(() => {
      expect(store.beginMessageRequest).toHaveBeenCalledWith('session-1', 'req-1', 'follow up');
      return new Promise<never>((_resolve, reject) => { rejectStart = reject; });
    });
    const request = trackMessageRequest(store, input, start);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const rejection = expect(request).rejects.toThrow('transform failed');
    rejectStart(new Error('transform failed'));
    await rejection;
    expect(store.settleMessageRequest).toHaveBeenCalledWith('session-1', 'req-1', 'failed', 'transform failed');
  });

  it('persists returned failures and queue acceptance', async () => {
    const store = harness();
    await trackMessageRequest(store, input, async () => ({ started: false, session_id: input.sessionId, error: 'rejected' }));
    expect(store.settleMessageRequest).toHaveBeenLastCalledWith('session-1', 'req-1', 'failed', 'rejected');
    await trackMessageRequest(store, input, async () => ({ started: true, session_id: input.sessionId }));
    expect(store.settleMessageRequest).toHaveBeenLastCalledWith('session-1', 'req-1', 'queued', null);
  });

  it('does not run a repeated request again', async () => {
    const store: MessageRequestStatusPort = {
      ...harness(), beginMessageRequest: async () => false,
      listMessageRequestStatuses: async () => [hydrateMessageRequestStatus({ request_id: 'req-1', status: 'queued' })],
    };
    const start = vi.fn();
    expect((await trackMessageRequest(store, input, start)).started).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('renews long-running submission ownership and clears its heartbeat on settlement', async () => {
    vi.useFakeTimers();
    try {
      const store = harness();
      let resolveStart!: (result: { started: boolean; session_id: string }) => void;
      const pending = trackMessageRequest(store, input, () => new Promise(resolve => { resolveStart = resolve; }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.renewMessageRequest).toHaveBeenCalledTimes(2);
      resolveStart({ started: true, session_id: 'session-1' });
      await pending;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(store.renewMessageRequest).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it.each([{}, { status: null }, { status: 'future' }, { content: 4, error: {} }])('normalizes partial receipt shapes idempotently: %j', (shape) => {
    const normalized = hydrateMessageRequestStatus({ request_id: 'req-1', ...shape });
    expect(normalized.status).toBe('unknown');
    expect(hydrateMessageRequestStatus({ ...normalized })).toEqual(normalized);
  });
});
