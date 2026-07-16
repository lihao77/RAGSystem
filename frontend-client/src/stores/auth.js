import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { getMe } from '../api/auth.ts';
import { useBootstrapStore } from './bootstrap.js';

const TOKEN_STORAGE_KEY = 'auth_token';
const SESSION_STORAGE_KEY = 'auth_session';

function readStoredSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || '{}');
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    return {};
  }
}

export const useAuthStore = defineStore('auth', () => {
  const bootstrapStore = useBootstrapStore();
  const storedSession = readStoredSession();
  const token = ref(localStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const user = ref(storedSession.user || null);
  const tenantId = ref(storedSession.tenantId || '');
  const role = ref(storedSession.role || '');
  const platformRole = ref(storedSession.platformRole || '');
  const identityLoaded = ref(false);

  const isAuthenticated = computed(() => Boolean(token.value));
  const isOwner = computed(() => role.value === 'owner');
  const isAdmin = computed(() => role.value === 'admin');
  const isTenantAdmin = computed(() => isAdmin.value || isOwner.value);
  const isPlatformAdmin = computed(() => platformRole.value === 'admin');

  function hasTenantRole(minimumRole) {
    if (bootstrapStore.profile.auth !== 'password') return true;
    if (minimumRole === 'member') return true;
    if (minimumRole === 'admin') return isTenantAdmin.value;
    if (minimumRole === 'owner') return isOwner.value;
    return false;
  }

  function setSession(session) {
    token.value = session?.token || '';
    user.value = session?.user || null;
    tenantId.value = session?.tenantId || '';
    role.value = session?.role || '';
    platformRole.value = session?.platformRole || '';
    identityLoaded.value = Boolean(session?.identityLoaded);

    if (token.value) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.value);
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        user: user.value,
        tenantId: tenantId.value,
        role: role.value,
        platformRole: platformRole.value,
      }));
    } else {
      clear();
    }
  }

  function clear() {
    token.value = '';
    user.value = null;
    tenantId.value = '';
    role.value = '';
    platformRole.value = '';
    identityLoaded.value = false;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  function setPlatformRoleHint(nextPlatformRole) {
    platformRole.value = nextPlatformRole || '';
  }

  async function refreshIdentity() {
    if (!token.value || identityLoaded.value) return;
    const identity = await getMe();
    setSession({
      token: token.value,
      user: identity.user || user.value,
      tenantId: identity.tenantId || tenantId.value,
      role: identity.role || role.value,
      platformRole: identity.platformRole || '',
      identityLoaded: true,
    });
  }

  return {
    token,
    user,
    tenantId,
    role,
    platformRole,
    identityLoaded,
    isAuthenticated,
    isOwner,
    isAdmin,
    isTenantAdmin,
    isPlatformAdmin,
    hasTenantRole,
    setSession,
    setPlatformRoleHint,
    refreshIdentity,
    clear,
  };
});
