import { ref, reactive, computed } from 'vue';

const visitedTabs = ref([]);
const cachedSet = reactive(new Set());

const cachedNames = computed(() => Array.from(cachedSet));

function getTitle(route) {
  return route?.meta?.title || (typeof route?.name === 'string' ? route.name : route?.path) || '';
}

function getCacheName(route) {
  return route?.meta?.cacheName || (typeof route?.name === 'string' ? route.name : '');
}

function openTab(route) {
  if (!route?.path) return;

  const path = route.path;
  const title = getTitle(route);
  const cacheName = getCacheName(route);
  const affix = path === '/';

  const existing = visitedTabs.value.find(t => t.path === path);
  if (!existing) {
    visitedTabs.value.push({ path, title, cacheName, affix });
  } else {
    existing.title = title;
    existing.cacheName = cacheName;
  }

  if (route?.meta?.keepAlive && cacheName) {
    cachedSet.add(cacheName);
  }
}

function isCached(cacheName) {
  return !!cacheName && cachedSet.has(cacheName);
}

function toggleCache(cacheName) {
  if (!cacheName) return;
  if (cachedSet.has(cacheName)) cachedSet.delete(cacheName);
  else cachedSet.add(cacheName);
}

function removeTabState(path) {
  const idx = visitedTabs.value.findIndex(t => t.path === path);
  if (idx === -1) return;
  const tab = visitedTabs.value[idx];
  if (tab?.cacheName) cachedSet.delete(tab.cacheName);
  visitedTabs.value.splice(idx, 1);
}

function closeOthersState(activePath) {
  visitedTabs.value = visitedTabs.value.filter(t => t.affix || t.path === activePath);
  cachedSet.clear();
  for (const t of visitedTabs.value) {
    if (t.cacheName) cachedSet.add(t.cacheName);
  }
}

function closeAllState() {
  visitedTabs.value = visitedTabs.value.filter(t => t.affix);
  cachedSet.clear();
}

export function usePageCache() {
  return {
    visitedTabs,
    cachedSet,
    cachedNames,
    openTab,
    isCached,
    toggleCache,
    removeTabState,
    closeOthersState,
    closeAllState
  };
}
