import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerSessionRoutes } from '../src/routes/agent/sessions.js';
import type { AgentRouteOptions } from '../src/routes/route-options.js';
import type { SessionApplication } from '../src/contracts/session/session-application.js';
import type { RequestApplications } from '../src/app/request-applications.js';
import { createTenantId, createUserId } from '../src/identity/types.js';

it('authorizes receipt queries before reading and preserves repeated request IDs', async () => {
  const tenantId = createTenantId('tnt_test');
  const list = vi.fn(async () => [{ request_id: 'r,1', status: 'failed', content: '补充', error: 'failure', message_id: null, updated_at: '' }]);
  const application = { getSession: async () => ({ tenant_id: tenantId, owner_user_id: 'usr_test', visibility: 'private' }), listMessageRequestStatuses: list } as unknown as SessionApplication;
  const app = Fastify();
  let userId = createUserId('usr_test');
  app.addHook('onRequest', async request => {
    request.identity = { tenantId, userId, role: 'member', permissions: [] };
    request.applications = { sessions: application } as unknown as RequestApplications;
  });
  await app.register(registerSessionRoutes, { prefix: '/api/agent', resolveSessionApplication: async () => application } as unknown as AgentRouteOptions);
  try {
    const response = await app.inject({ method: 'GET', url: '/api/agent/sessions/s1/message-requests?request_ids=r%2C1&request_ids=r2' });
    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith('s1', ['r,1', 'r2']);
    expect(response.json().data.items[0].status).toBe('failed');
    userId = createUserId('usr_other');
    expect((await app.inject({ method: 'GET', url: '/api/agent/sessions/s1/message-requests' })).statusCode).toBe(403);
    expect(list).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});
