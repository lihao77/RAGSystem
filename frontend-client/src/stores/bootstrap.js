import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { getBootstrap } from '../api/bootstrap.js';

export const useBootstrapStore = defineStore('bootstrap', () => {
  const profile = ref({});
  const capabilities = ref({});
  const installed = ref(false);
  const loaded = ref(false);

  const requiresAuth = computed(() => installed.value && profile.value.auth !== 'local');
  const needsInstall = computed(() => !installed.value);

  async function load(force = false) {
    if (loaded.value && !force) return profile.value;

    const response = await getBootstrap();
    const { capabilities: nextCapabilities = {}, installed: nextInstalled = false, ...nextProfile } = response || {};
    profile.value = nextProfile;
    capabilities.value = nextCapabilities;
    installed.value = Boolean(nextInstalled);
    loaded.value = true;
    return profile.value;
  }

  return {
    profile,
    capabilities,
    installed,
    loaded,
    requiresAuth,
    needsInstall,
    load,
  };
});
