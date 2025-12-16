<template>
  <div class="sidebar-container">
    <el-menu :default-active="activeIndex" class="sidebar-menu" :collapse="props.isCollapse" :collapse-transition="true"
      router @select="handleSelect">
      <el-menu-item index="/">
        <el-icon>
          <HomeFilled />
        </el-icon>
        <template #title><span>首页</span></template>
      </el-menu-item>
      <!-- <el-menu-item index="/graph">
        <el-icon><Share /></el-icon>
        <template #title><span>知识图谱</span></template>
      </el-menu-item>
      <el-menu-item index="/map">
        <el-icon><Location /></el-icon>
        <template #title><span>地理视图</span></template>
      </el-menu-item> -->
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
      <el-menu-item index="/settings">
        <el-icon>
          <Setting />
        </el-icon>
        <template #title><span>系统配置</span></template>
      </el-menu-item>
      <el-menu-item index="/nodes">
        <el-icon>
          <Grid />
        </el-icon>
        <template #title><span>节点系统</span></template>
      </el-menu-item>
      <el-menu-item index="/workflow">
        <el-icon>
          <Share />
        </el-icon>
        <template #title><span>工作流编排</span></template>
      </el-menu-item>
      <el-menu-item index="/files">
        <el-icon>
          <Folder />
        </el-icon>
        <template #title><span>文件管理</span></template>
      </el-menu-item>
      <!-- <el-sub-menu index="data-management">
        <template #title>
          <el-icon>
            <Document />
          </el-icon>
          <span>数据管理</span>
        </template>
        <el-menu-item index="/import">
          <el-icon>
            <Upload />
          </el-icon>
          <template #title><span>数据导入</span></template>
        </el-menu-item>
        <el-menu-item index="/evaluation">
          <el-icon>
            <DataAnalysis />
          </el-icon>
          <template #title><span>图谱评估</span></template>
        </el-menu-item>
      </el-sub-menu> -->
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
import { Grid, Share, Folder } from '@element-plus/icons-vue';

// 接收 props
const props = defineProps({
  isCollapse: {
    type: Boolean,
    default: false
  }
});

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
  display: flex;
  flex-direction: column;
}

.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  border-right: none;
  padding-bottom:40px;
  /* 为footer留出空间 */
  transition: width 0.3s;
}

/* .sidebar-menu:not(.el-menu--collapse) {
  width: 249px;
} */

.sidebar-menu {
  width: 100%;
}

.sidebar-footer {
  position: absolute;
  width: 100%;
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

:deep(.el-menu-item){
  gap: 15px;
}

:deep(.el-sub-menu__title){
  gap: 15px;
}

.connection-status {
  margin-top: 10px;
  display: flex;
  justify-content: center;
}
</style>