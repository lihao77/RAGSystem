import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { getMe } from '../api/auth.ts';

/** 本地隐式身份；场景切换后重新从后端解析，不恢复历史登录令牌。 */
export const useAuthStore = defineStore('auth', () => {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_session');
  const user = ref({ id: 'usr_local', displayName: 'Local User' });
  const tenantId = ref('tnt_local');
  const role = ref('owner');
  const platformRole = ref('admin');
  const identityLoaded = ref(false);
  const isAuthenticated = computed(() => identityLoaded.value);
  const isOwner = computed(() => role.value === 'owner');
  const isAdmin = computed(() => role.value === 'admin');
  const isTenantAdmin = computed(() => isAdmin.value || isOwner.value);
  const isPlatformAdmin = computed(() => platformRole.value === 'admin');

  function hasTenantRole(minimumRole) {
    if (minimumRole === 'member') return true;
    if (minimumRole === 'admin') return isTenantAdmin.value;
    if (minimumRole === 'owner') return isOwner.value;
    return false;
  }

  async function refreshIdentity() {
    const identity = await getMe();
    user.value = identity.user;
    tenantId.value = identity.tenantId;
    role.value = identity.role;
    platformRole.value = identity.platformRole || '';
    identityLoaded.value = true;
  }

  return { user, tenantId, role, platformRole, identityLoaded, isAuthenticated,
    isOwner, isAdmin, isTenantAdmin, isPlatformAdmin, hasTenantRole, refreshIdentity };
});
