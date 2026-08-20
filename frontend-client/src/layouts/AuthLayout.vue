<template>
  <main class="relative flex min-h-full items-center justify-center bg-background px-4 py-10 text-foreground">
    <!-- Electron 桌面端：登录/安装页无侧栏 logo 行，顶部空白条作窗口拖拽区（浏览器中无效） -->
    <div class="auth-drag-strip" aria-hidden="true"></div>
    <div class="flex w-full max-w-xl flex-col gap-6">
      <div class="flex items-center justify-center gap-3">
        <IconLogo :size="36" simple />
        <div>
          <div class="text-lg font-semibold">RAGSystem</div>
          <div class="text-sm text-muted-foreground">智能知识与 Agent 工作台</div>
        </div>
      </div>
      <slot />
    </div>
  </main>
</template>

<script setup>
import { IconLogo } from '../components/icons';
</script>

<style scoped>
.auth-drag-strip {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 44px;
  -webkit-app-region: drag;
  app-region: drag;
  pointer-events: auto;
}
</style>
