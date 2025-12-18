<template>
  <div class="tabbar">
    <el-scrollbar class="tabbar-scrollbar">
      <el-tabs
        v-model="activePath"
        type="card"
        class="tabbar-tabs"
        @tab-change="onTabChange"
        @tab-remove="onTabRemove"
      >
        <el-tab-pane
          v-for="tab in tabs"
          :key="tab.path"
          :name="tab.path"
          :closable="!tab.affix"
        >
          <template #label>
            <div class="tab-label-wrapper">
              <el-icon v-if="tab.affix" class="affix-icon" :size="14">
                <Paperclip />
              </el-icon>
              <span class="tab-title">{{ tab.title }}</span>
              <el-tooltip
                v-if="tab.cacheName"
                :content="isCached(tab.cacheName) ? '已缓存（点击关闭）' : '未缓存（点击开启）'"
                placement="top"
              >
                <span 
                  class="cache-indicator"
                  :class="{ 'cached': isCached(tab.cacheName) }"
                  @click.stop="toggleTabCache(tab)"
                >
                  ●
                </span>
              </el-tooltip>
            </div>
          </template>
        </el-tab-pane>
      </el-tabs>
    </el-scrollbar>

    <el-dropdown trigger="click" class="tabbar-dropdown">
      <el-button size="small" text type="primary">
        操作
        <el-icon class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item @click="closeOthers">
            <el-icon><CircleClose /></el-icon>
            关闭其他
          </el-dropdown-item>
          <el-dropdown-item @click="closeAll">
            <el-icon><Close /></el-icon>
            关闭全部
          </el-dropdown-item>
          <el-dropdown-item divided @click="clearAllCache">
            <el-icon><Delete /></el-icon>
            清空所有缓存
          </el-dropdown-item>
          <el-dropdown-item @click="refreshCurrent">
            <el-icon><Refresh /></el-icon>
            刷新当前页
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowDown, CircleClose, Close, Delete, Refresh, Paperclip } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { usePageCache } from '@/composables/usePageCache';

const route = useRoute();
const router = useRouter();

const { visitedTabs, isCached, toggleCache, removeTabState, closeOthersState, closeAllState, cachedSet } = usePageCache();

const tabs = computed(() => visitedTabs.value);
const activePath = ref(route.path);

watch(
  () => route.path,
  (p) => {
    activePath.value = p;
  }
);

function onTabChange(path) {
  if (path && path !== route.path) router.push(path);
}

function onTabRemove(path) {
  const idx = tabs.value.findIndex(t => t.path === path);
  const isActive = route.path === path;

  removeTabState(path);

  if (!isActive) return;

  const remain = tabs.value;
  const next = remain[idx - 1] || remain[idx] || remain[remain.length - 1];
  router.push(next?.path || '/');
}

function toggleTabCache(tab) {
  const wasCached = isCached(tab.cacheName);
  toggleCache(tab.cacheName);
  
  if (wasCached) {
    ElMessage.info({
      message: '已关闭缓存，切换页面后生效',
      duration: 2000
    });
  } else {
    ElMessage.success({
      message: '已开启缓存',
      duration: 2000
    });
  }
}

function closeOthers() {
  closeOthersState(route.path);
  ElMessage.success('已关闭其他标签页');
}

function closeAll() {
  closeAllState();
  router.push('/');
  ElMessage.success('已关闭全部标签页');
}

function clearAllCache() {
  const count = cachedSet.size;
  cachedSet.clear();
  ElMessage.warning(`已清空 ${count} 个页面缓存，切换页面后生效`);
}

function refreshCurrent() {
  const currentTab = tabs.value.find(t => t.path === route.path);
  if (currentTab?.cacheName) {
    cachedSet.delete(currentTab.cacheName);
    nextTick(() => {
      router.replace({ path: '/redirect' + route.fullPath });
      setTimeout(() => {
        router.replace(route.fullPath);
        if (currentTab.cacheName) {
          cachedSet.add(currentTab.cacheName);
        }
      }, 100);
    });
  } else {
    router.go(0);
  }
}
</script>

<style scoped>
.tabbar {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--el-bg-color);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.05);
}

.tabbar-scrollbar {
  flex: 1;
  min-width: 0;
}

.tabbar-scrollbar :deep(.el-scrollbar__wrap) {
  overflow-x: auto;
  overflow-y: hidden;
}

.tabbar-scrollbar :deep(.el-scrollbar__view) {
  display: flex;
}

.tabbar-tabs {
  flex: 1;
  min-width: max-content;
}

.tabbar :deep(.el-tabs__header) {
  margin: 0;
  border-bottom: none;
}

.tabbar :deep(.el-tabs__nav) {
  border: none;
}

.tabbar :deep(.el-tabs__item) {
  border-bottom: none;
}

.tab-label-wrapper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.affix-icon {
  color: var(--el-color-primary);
  opacity: 0.6;
}

.tab-title {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cache-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 10px;
  cursor: pointer;
  user-select: none;
  color: var(--el-color-info);
  opacity: 0.5;
  transition: all 0.2s;
}

.cache-indicator:hover {
  opacity: 1;
  transform: scale(1.2);
}

.cache-indicator.cached {
  color: var(--el-color-success);
  opacity: 1;
}

.tabbar-dropdown {
  flex-shrink: 0;
  padding-right: 12px;
}

.tabbar-dropdown :deep(.el-dropdown-menu__item) {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
