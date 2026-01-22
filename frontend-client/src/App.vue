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
</style>
