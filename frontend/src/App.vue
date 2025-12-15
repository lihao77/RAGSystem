<template>
  <div class="app-container">
      <!-- <el-header height="60px">
        <header-component />
      </el-header> -->
      <el-container id="main">
        <el-aside :width="asideWidth" class="sidebar-aside">
          <sidebar-menu :is-collapse="isCollapse" />
          <!-- 折叠按钮 -->
          <div class="collapse-btn" @click="toggleCollapse">
            <el-icon :class="{ 'rotate-180': isCollapse }">
              <Fold v-if="!isCollapse" />
              <Expand v-else />
            </el-icon>
          </div>
        </el-aside>
        <el-main>
          <router-view />
        </el-main>
      </el-container>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import HeaderComponent from './components/layout/HeaderComponent.vue';
import SidebarMenu from './components/layout/SidebarMenu.vue';

const asideWidth = ref('250px');
const isCollapse = ref(false);

// 切换折叠状态
const toggleCollapse = () => {
  isCollapse.value = !isCollapse.value;
  asideWidth.value = isCollapse.value ? '64px' : '250px';
};
</script>

<style>
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
  overflow: visible;
  position: relative;
}

.collapse-btn {
  position: fixed;
  top: 13px;
  left: calc(var(--el-aside-width, 300px) - 15px);
  width: 30px;
  height: 30px;
  background-color: #409EFF;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: all 0.3s;
}

.collapse-btn:hover {
  background-color: #66b1ff;
  transform: scale(1.1);
}

.collapse-btn .el-icon {
  color: white;
  font-size: 18px;
  transition: transform 0.3s;
}

.collapse-btn .el-icon.rotate-180 {
  transform: rotate(180deg);
}

.el-main {
  background-color: #ffffff;
  color: #333;
  padding: 20px;
  overflow-y: auto;
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