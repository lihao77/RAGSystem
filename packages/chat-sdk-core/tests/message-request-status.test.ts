import { expect, it, vi } from 'vitest';
import { createRagChatClient } from '../src/index.js';

it('queries durable send receipts through the configured SDK endpoint without conflating request IDs', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, message: '', data: { items: [] } }), { status: 200 }));
  const client = createRagChatClient({ baseUrl: 'https://rag.example.test', fetch: fetchMock });
  await client.listMessageRequestStatuses('session-1', ['req,one', 'req two']);
  const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
  expect(url.pathname).toBe('/api/agent/sessions/session-1/message-requests');
  expect(url.searchParams.getAll('request_ids')).toEqual(['req,one', 'req two']);
  client.destroy();
});

it('cancels the original request with its displayed content as a concurrency guard', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, message: '', data: { item: {} } }), { status: 200 }));
  const client = createRagChatClient({ baseUrl: 'https://rag.example.test', fetch: fetchMock });
  await client.cancelQueuedMessageRequest('s1', 'r/1', '原文');
  expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toBe('/api/agent/sessions/s1/message-requests/r%2F1');
  expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ expected_content: '原文' });
  client.destroy();
});
