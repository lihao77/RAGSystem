<template>
  <div class="app-container">
      <!-- <el-header height="60px">
        <header-component />
      </el-header> -->
      <el-container id="main">
        <el-aside :width="asideWidth" class="sidebar-aside">
          <sidebar-menu :is-collapse="isCollapse" @toggle-collapse="toggleCollapse" />
        </el-aside>
        <el-main class="main-content">
          <TabBar class="main-tabbar" />
          <div class="main-view">
            <router-view v-slot="{ Component }">
              <keep-alive :include="cachedNames">
                <component :is="Component" />
              </keep-alive>
            </router-view>
          </div>
        </el-main>
      </el-container>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import HeaderComponent from './components/layout/HeaderComponent.vue';
import SidebarMenu from './components/layout/SidebarMenu.vue';
import TabBar from './components/layout/TabBar.vue';
import { usePageCache } from '@/composables/usePageCache';

const asideWidth = ref('250px');
const isCollapse = ref(false);
const { cachedNames } = usePageCache();

// 切换折叠状态
const toggleCollapse = () => {
  isCollapse.value = !isCollapse.value;
  asideWidth.value = isCollapse.value ? '64px' : '250px';
};
</script>

<style scoped>
.app-container {
  height: 100vh;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}


.el-header {
  background-color: #409EFF;
  color: white;
  line-height: 60px;
  padding: 0;
}

.el-aside {
  background-color: #f8f9fa;
  color: #333;
  border-right: 1px solid #e6e6e6;
  transition: width 0.3s;
}

.sidebar-aside {
  overflow: hidden;
  position: relative;
  box-shadow: 2px 0 8px rgba(0, 0, 0, 0.06);
}

.el-main {
  background-color: #ffffff;
  color: #333;
  padding: 0;
  overflow-y: auto;
}

.main-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main-tabbar {
  flex-shrink: 0;
}

.main-view {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
  min-height: 0;
}

#main {
  flex: 1;
  position: fixed;
  top: 0px;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
}
</style>