import { storeToRefs } from 'pinia';
import { useAuthStore } from '../stores/auth.js';

export function usePermission() {
  const authStore = useAuthStore();
  const { isOwner, isAdmin, isTenantAdmin, isPlatformAdmin } = storeToRefs(authStore);

  return {
    isOwner,
    isAdmin,
    isTenantAdmin,
    isPlatformAdmin,
    hasTenantRole: authStore.hasTenantRole,
  };
}
