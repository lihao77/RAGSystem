import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import MockAdapter from 'axios-mock-adapter';
import { httpClient } from '../api/http.js';
import { useAuthStore } from './auth.js';

test('local identity discards historical account credentials', () => {
  localStorage.setItem('auth_token', 'old-token');
  localStorage.setItem('auth_session', JSON.stringify({ user: { id: 'usr_old' }, role: 'member' }));
  setActivePinia(createPinia());
  const auth = useAuthStore();
  assert.equal(auth.user.id, 'usr_local');
  assert.equal(auth.role, 'owner');
  assert.equal(localStorage.getItem('auth_token'), null);
  assert.equal(localStorage.getItem('auth_session'), null);
  auth.$dispose();
});

test('identity refresh follows the active scene without sending an old bearer token', async (t) => {
  setActivePinia(createPinia());
  const mock = new MockAdapter(httpClient);
  const auth = useAuthStore();
  t.after(() => { mock.restore(); auth.$dispose(); });
  for (const tenantId of ['tnt_work', 'tnt_local']) {
    mock.onGet('/api/auth/me').reply((config) => {
      assert.equal(config.headers.get('Authorization'), undefined);
      return [200, { user: { id: 'usr_local', displayName: 'Local User' }, userId: 'usr_local',
        tenantId, role: 'owner', platformRole: 'admin', permissions: ['*'] }];
    });
    await auth.refreshIdentity();
    assert.equal(auth.tenantId, tenantId);
    assert.equal(auth.identityLoaded, true);
    assert.equal(auth.hasTenantRole('owner'), true);
  }
});
