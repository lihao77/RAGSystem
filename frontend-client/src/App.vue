<template>
  <div id="app">
    <ChatView />
  </div>
</template>

<script setup>
import ChatView from './views/ChatView.vue';
import 'highlight.js/styles/github-dark.css';
</script>

<style>
/* ===== 全局 CSS 变量 ===== */
:root {
  /* 颜色系统 */
  --color-primary: #6366f1;
  --color-primary-hover: #4f46e5;
  --color-text-main: #1a1a1a;
  --color-text-secondary: #6b7280;
  --color-text-muted: #9ca3af;
  --color-bg-app: #f8f9fa;
  --color-bg-message-user: #e8eaff;
  --color-bg-message-assistant: #ffffff;
  --color-border: #e5e7eb;
  --color-error: #dc2626;
  --color-error-bg: #fef2f2;
  --color-success: #10b981;
  --color-warning: #f59e0b;

  /* 间距 */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;

  /* 圆角 */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-full: 9999px;

  /* 过渡 */
  --transition-fast: 0.15s ease;
  --transition-normal: 0.3s ease;

  /* 字体 */
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

/* ===== 全局重置 ===== */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

body {
  font-family: var(--font-sans);
  color: var(--color-text-main);
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

#app {
  width: 100%;
  height: 100%;
}

/* ===== 滚动条样式 ===== */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.15);
}
</style>
