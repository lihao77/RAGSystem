<template>
  <div class="sidebar-container">
    <!-- 侧边栏头部 -->
    <div class="sidebar-header">
      <div v-if="!props.isCollapse" class="header-content">
        <div class="header-logo">
          <el-icon :size="24" color="#409EFF">
            <Share />
          </el-icon>
          <transition name="slide-fade">
            <span v-show="!props.isCollapse" class="system-title">知识图谱</span>
          </transition>
        </div>
        <el-tooltip content="折叠侧边栏" placement="bottom">
          <el-button class="collapse-toggle" text @click="toggleCollapse">
            <el-icon><Fold /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
      <div v-else class="header-collapsed">
        <el-tooltip content="展开侧边栏" placement="right">
          <el-button class="collapse-toggle" text @click="toggleCollapse">
            <el-icon :size="20"><Expand /></el-icon>
          </el-button>
        </el-tooltip>
      </div>
    </div>

    <el-menu 
      :default-active="activeIndex" 
      class="sidebar-menu" 
      :collapse="props.isCollapse" 
      :collapse-transition="false"
      :unique-opened="true"
      router 
      @select="handleSelect"
    >
      <!-- 首页 -->
      <el-menu-item index="/">
        <el-icon>
          <HomeFilled />
        </el-icon>
        <template #title><span>首页</span></template>
      </el-menu-item>

      <!-- 数据分析 -->
      <el-sub-menu index="data-analysis">
        <template #title>
          <el-icon>
            <DataAnalysis />
          </el-icon>
          <span class="menu-title-text">数据分析</span>
        </template>
        <el-menu-item index="/split">
          <el-icon>
            <Location />
          </el-icon>
          <template #title><span>综合视图</span></template>
        </el-menu-item>
        <el-menu-item index="/search">
          <el-icon>
            <Search />
          </el-icon>
          <template #title><span>实体查询</span></template>
        </el-menu-item>
        <el-menu-item index="/graphrag">
          <el-icon>
            <ChatDotRound />
          </el-icon>
          <template #title><span>GraphRAG 问答</span></template>
        </el-menu-item>
      </el-sub-menu>

      <!-- 系统管理 -->
      <el-sub-menu index="system-manage">
        <template #title>
          <el-icon>
            <Tools />
          </el-icon>
          <span class="menu-title-text">系统管理</span>
        </template>
        <el-menu-item index="/nodes">
          <el-icon>
            <Grid />
          </el-icon>
          <template #title><span>节点系统</span></template>
        </el-menu-item>
        <el-menu-item index="/workflow">
          <el-icon>
            <Connection />
          </el-icon>
          <template #title><span>工作流编排</span></template>
        </el-menu-item>
        <el-menu-item index="/files">
          <el-icon>
            <Folder />
          </el-icon>
          <template #title><span>文件管理</span></template>
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon>
            <Setting />
          </el-icon>
          <template #title><span>系统配置</span></template>
        </el-menu-item>
      </el-sub-menu>
    </el-menu>

    <div class="sidebar-footer" v-if="!props.isCollapse">
      <!-- <el-divider /> -->
      <div class="connection-status">
        <el-tag :type="isConnected ? 'success' : 'danger'" size="small">
          {{ isConnected ? 'Neo4j 已连接' : 'Neo4j 未连接' }}
        </el-tag>
      </div>
    </div>

    <!-- 折叠状态下的连接状态指示器 -->
    <div class="sidebar-footer-collapsed" v-else>
      <el-tooltip :content="isConnected ? 'Neo4j 已连接' : 'Neo4j 未连接'" placement="right">
        <div class="status-indicator" :class="{ 'connected': isConnected, 'disconnected': !isConnected }"></div>
      </el-tooltip>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { 
  Grid, Folder, Fold, Expand, DataAnalysis, Tools, Connection,
  HomeFilled, Location, Search, ChatDotRound, Setting
} from '@element-plus/icons-vue';

// 接收 props
const props = defineProps({
  isCollapse: {
    type: Boolean,
    default: false
  }
});

// 定义 emits
const emit = defineEmits(['toggle-collapse']);

const route = useRoute();
const router = useRouter();
const isConnected = ref(false);

// 根据当前路由设置活动菜单项
const activeIndex = computed(() => {
  return route.path;
});

// 菜单选择处理
const handleSelect = (key) => {
  router.push(key);
};

// 切换折叠状态
const toggleCollapse = () => {
  emit('toggle-collapse');
};

// 模拟检查Neo4j连接状态
onMounted(() => {
  // 这里应该实际检查Neo4j连接状态
  setTimeout(() => {
    isConnected.value = true;
  }, 1000);
});
</script>

<style scoped>
.sidebar-container {
  position: relative;
  height: calc(100%);
  overflow-y: hidden;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

/* 侧边栏头部 */
.sidebar-header {
  flex-shrink: 0;
  height: 60px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--el-border-color-lighter);
  background: linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.04);
}

.header-content {
  width: 100%;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition: all 0.3s ease;
}

.header-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  position: relative;
  min-width: 0;
}

.system-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  letter-spacing: 0.5px;
  white-space: nowrap;
  overflow: hidden;
}

.header-collapsed {
  width: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
}

.collapse-toggle {
  padding: 8px;
  transition: all 0.2s;
}

.collapse-toggle:hover {
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

/* slide-fade 过渡动画 - 用于头部标题文字 */
.slide-fade-enter-active {
  transition: all 0.3s ease;
  transition-delay: 0.05s;
}

.slide-fade-leave-active {
  transition: all 0.25s ease;
  position: absolute;
}

.slide-fade-enter-from {
  opacity: 0;
  transform: translateX(-10px);
}

.slide-fade-leave-to {
  opacity: 0;
  transform: translateX(-10px);
}

/* 菜单文字动画 - 通过 CSS 类控制 */
.menu-title-text {
  transition: opacity 0.25s ease, width 0.25s ease;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  border-right: none;
  margin-bottom: 60px;
  /* 为footer留出空间 */
  width: 100%;
    /* 禁止横向滚动 */
  overflow-x: hidden;
}

/* 菜单折叠时的平滑过渡 */
.sidebar-menu :deep(.el-menu-item),
.sidebar-menu :deep(.el-sub-menu__title) {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 折叠时隐藏菜单文字 - Element Plus 自动处理 */
.sidebar-menu.el-menu--collapse :deep(.el-sub-menu__title span:not(.el-icon)),
.sidebar-menu.el-menu--collapse :deep(.el-menu-item span) {
  opacity: 0;
  width: 0;
  transition: opacity 0.25s ease, width 0.25s ease;
}

/* 展开时显示菜单文字 */
.sidebar-menu:not(.el-menu--collapse) :deep(.el-sub-menu__title span:not(.el-icon)),
.sidebar-menu:not(.el-menu--collapse) :deep(.el-menu-item span) {
  opacity: 1;
  transition: opacity 0.3s ease 0.05s;
}

/* 美化滚动条 */
.sidebar-menu::-webkit-scrollbar {
  width: 6px;
}

.sidebar-menu::-webkit-scrollbar-track {
  background: transparent;
}

.sidebar-menu::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
}

.sidebar-menu::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.2);
}

/* 子菜单项缩进优化 */
.sidebar-menu :deep(.el-sub-menu__title) {
  font-weight: 600;
  position: relative;
  overflow: hidden;
}

.sidebar-menu :deep(.el-sub-menu__title span) {
  white-space: nowrap;
  overflow: hidden;
}

.sidebar-menu :deep(.el-menu-item) {
  min-height: 48px;
}

.sidebar-footer {
  position: absolute;
  width: calc(var(--el-aside-width) - 1px);
    /* 禁止横向滚动 */
  overflow-x: hidden;
  bottom: 0;
  left: 0;
  padding: 10px;
  padding-top: 0;
  text-align: center;
  background-color: rgb(255, 255, 255);
  z-index: 10;
  /* 确保在菜单内容之上 */
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.05);
  /* 添加阴影效果，区分底部区域 */
}

.sidebar-footer-collapsed {
  position: absolute;
  width: 100%;
  bottom: 0;
  left: 0;
  padding: 14px 0;
  text-align: center;
  background-color: rgb(255, 255, 255);
  z-index: 10;
  box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.05);
}

.status-indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  margin: 0 auto;
}

.status-indicator.connected {
  background-color: #67c23a;
  box-shadow: 0 0 6px rgba(103, 194, 58, 0.6);
}

.status-indicator.disconnected {
  background-color: #f56c6c;
  box-shadow: 0 0 6px rgba(245, 108, 108, 0.6);
}

:deep(.el-menu-item) {
  gap: 12px;
}

:deep(.el-sub-menu__title) {
  gap: 12px;
  font-weight: 500;
  color: var(--el-text-color-regular);
}

:deep(.el-sub-menu__title:hover) {
  background-color: var(--el-fill-color-light);
}

/* 二级菜单项样式 */
:deep(.el-sub-menu .el-menu-item) {
  padding-left: 48px !important;
  background-color: var(--el-fill-color-blank);
}

:deep(.el-sub-menu .el-menu-item:hover) {
  background-color: var(--el-fill-color-lighter);
}

.connection-status {
  margin-top: 10px;
  display: flex;
  justify-content: center;
}
</style>