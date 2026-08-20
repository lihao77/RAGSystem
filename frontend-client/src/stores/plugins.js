import { ref } from 'vue';
import { defineStore } from 'pinia';
import { getPluginUiManifests, getInstalledPlugins } from '../api/plugins.js';

/**
 * 插件清单状态。
 *
 * uiManifests：公开 view 清单（路由守卫认证前加载一次，路由注册在 router/index.js）；
 * installed：完整清单（插件设置页懒加载，含 configGroups）。
 */
export const usePluginStore = defineStore('plugins', () => {
  const uiManifests = ref([]);
  const uiManifestsLoaded = ref(false);
  const installed = ref([]);
  const installedLoaded = ref(false);

  async function loadUiManifests() {
    if (uiManifestsLoaded.value) return uiManifests.value;
    try {
      uiManifests.value = await getPluginUiManifests();
    } catch {
      uiManifests.value = []; // 后端不可达/未装插件：空清单，不阻塞主流程
    } finally {
      uiManifestsLoaded.value = true;
    }
    return uiManifests.value;
  }

  async function loadInstalled(force = false) {
    if (installedLoaded.value && !force) return installed.value;
    installed.value = await getInstalledPlugins();
    installedLoaded.value = true;
    return installed.value;
  }

  return {
    uiManifests,
    uiManifestsLoaded,
    installed,
    installedLoaded,
    loadUiManifests,
    loadInstalled,
  };
});
