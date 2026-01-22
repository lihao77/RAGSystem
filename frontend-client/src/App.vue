<template>
  <div id="app">
    <div class="theme-toggle">
      <button @click="toggleTheme" class="theme-btn" :title="isDark ? '切换到亮色模式' : '切换到暗色模式'">
        <!-- Sun icon for dark mode -->
        <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
        <!-- Moon icon for light mode -->
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
      </button>
    </div>
    <ChatView />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import ChatView from './views/ChatView.vue';
import 'highlight.js/styles/github-dark.css';

const isDark = ref(true);

const toggleTheme = () => {
  isDark.value = !isDark.value;
  updateTheme();
};

const updateTheme = () => {
  const root = document.documentElement;
  if (isDark.value) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }
  // 保存用户偏好
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
};

onMounted(() => {
  // 检查本地存储或系统偏好
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    isDark.value = savedTheme === 'dark';
  } else {
    // 默认暗色模式
    isDark.value = true;
  }
  updateTheme();
});
</script>

<style>
/* ===== Ultra-Premium Minimalist Design System ===== */
:root {
  /* Primary Colors - Desaturated Indigo */
  --color-primary: #818cf8;
  --color-primary-hover: #a5b4fc;
  --color-primary-glow: rgba(129, 140, 248, 0.15);
  --color-primary-subtle: rgba(129, 140, 248, 0.08);

  /* Background Layers - Matte Deep Space */
  --color-bg-app: #09090b;       /* Zinc 950 - 最深背景 */
  --color-bg-primary: #18181b;   /* Zinc 900 - 卡片背景 */
  --color-bg-secondary: #27272a; /* Zinc 800 - 悬停/次级背景 */
  --color-bg-tertiary: #3f3f46;  /* Zinc 700 - 激活状态 */
  --color-bg-elevated: #27272a;  /* 浮层 */

  /* Text Colors - Pure & Crisp */
  --color-text-primary: #ffffff;   /* Zinc 100 */
  --color-text-secondary: #dddddd; /* Zinc 400 */
  --color-text-muted: #616161;     /* Zinc 600 */
  --color-text-inverse: #09090b;

  /* Message Backgrounds */
  --color-bg-message-user: #27272a;
  --color-bg-message-assistant: transparent;

  /* Borders - Ultra Thin & Subtle */
  --color-border: rgba(255, 255, 255, 0.06);
  --color-border-hover: rgba(255, 255, 255, 0.12);
  --color-border-focus: rgba(129, 140, 248, 0.4);

  /* Status Colors - Muted */
  --color-success: #34d399;
  --color-success-bg: rgba(52, 211, 153, 0.1);
  --color-warning: #fbbf24;
  --color-warning-bg: rgba(251, 191, 36, 0.1);
  --color-error: #f87171;
  --color-error-bg: rgba(248, 113, 113, 0.1);

  /* Minimal Glass - Only for overlays */
  --glass-bg: rgba(9, 9, 11, 0.8);
  --glass-bg-light: rgba(24, 24, 27, 0.6);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.2);
  --glass-blur: 20px;

  /* Refined Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.3);
  --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.3), 0 2px 4px -1px rgba(0,0,0,0.15);
  --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.4), 0 4px 6px -2px rgba(0,0,0,0.2);

  /* Spacing - 4px Grid */
  --spacing-xs: 4px;
  --spacing-sm: 8px;
  --spacing-md: 16px;
  --spacing-lg: 24px;
  --spacing-xl: 32px;
  --spacing-2xl: 64px;

  /* Border Radius - Consistent */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-2xl: 24px;
  --radius-full: 9999px;

  /* Transitions */
  --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
  --transition-normal: 0.25s cubic-bezier(0.4, 0, 0.2, 1);

  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
}

:root[data-theme="light"] {
  /* Primary Colors - Indigo */
  --color-primary: #4f46e5;
  --color-primary-hover: #4338ca;
  --color-primary-glow: rgba(79, 70, 229, 0.15);
  --color-primary-subtle: rgba(79, 70, 229, 0.08);

  /* Background Layers - Light */
  --color-bg-app: #f4f4f5;       /* Zinc 100 */
  --color-bg-primary: #ffffff;   /* White */
  --color-bg-secondary: #f2f2f2; /* Zinc 100 */
  --color-bg-tertiary: #d8d8db;  /* Zinc 200 */
  --color-bg-elevated: #ffffff;

  /* Text Colors */
  --color-text-primary: #18181b;   /* Zinc 900 */
  --color-text-secondary: #52525b; /* Zinc 600 */
  --color-text-muted: #a1a1aa;     /* Zinc 400 */
  --color-text-inverse: #ffffff;

  /* Message Backgrounds */
  --color-bg-message-user: #e4e4e7;
  --color-bg-message-assistant: transparent;

  /* Borders */
  --color-border: #e4e4e7;       /* Zinc 200 */
  --color-border-hover: #d4d4d8; /* Zinc 300 */
  --color-border-focus: rgba(79, 70, 229, 0.4);

  /* Glass - Light */
  --glass-bg: rgba(255, 255, 255, 0.8);
  --glass-bg-light: rgba(255, 255, 255, 0.6);
  --glass-border: rgba(0, 0, 0, 0.05);
  --glass-shadow: 0 4px 12px rgba(0,0,0,0.05);
}

/* ===== Global Reset ===== */
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--color-bg-app);
}

body {
  font-family: var(--font-sans);
  color: var(--color-text-primary);
  font-size: 14px;
  line-height: 1.5;
  letter-spacing: -0.01em;
}

#app {
  width: 100%;
  height: 100%;
}

/* ===== Minimal Scrollbar ===== */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* ===== Selection Styling ===== */
::selection {
  background: var(--color-primary-subtle);
  color: var(--color-text-primary);
}

/* ===== Focus Outline ===== */
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

/* ===== Theme Toggle ===== */
.theme-toggle {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 1000;
}

.theme-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--transition-normal);
  box-shadow: var(--shadow-md);
}

.theme-btn:hover {
  background: var(--color-bg-secondary);
  border-color: var(--color-border-hover);
  transform: translateY(-2px);
}
</style>
