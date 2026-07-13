import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

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
  const storedSession = readStoredSession();
  const token = ref(localStorage.getItem(TOKEN_STORAGE_KEY) || '');
  const user = ref(storedSession.user || null);
  const tenantId = ref(storedSession.tenantId || '');
  const role = ref(storedSession.role || '');

  const isAuthenticated = computed(() => Boolean(token.value));

  function setSession(session) {
    token.value = session?.token || '';
    user.value = session?.user || null;
    tenantId.value = session?.tenantId || '';
    role.value = session?.role || '';

    if (token.value) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.value);
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
        user: user.value,
        tenantId: tenantId.value,
        role: role.value,
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
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  return { token, user, tenantId, role, isAuthenticated, setSession, clear };
});
