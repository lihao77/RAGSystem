import { createApp } from 'vue';

import SchedulerPanel from './SchedulerPanel.vue';

/**
 * 插件 UI bundle 入口（plugin-ui-sdk 契约 apiVersion 1）：
 * 唯一必需导出 mountView——宿主提供 DOM 容器与 host 上下文，
 * 插件在容器内自建 Vue app（bundle 自带 Vue 运行时，不与宿主共享实例）。
 */

// 样式与 bundle 同目录输出（vite assetFileNames 固定为 style.css）；
// 以 import.meta.url 推导实际伺服地址，动态 import bundle 时样式不会被自动加载，需手工挂 <link>。
const STYLE_HREF = new URL('./style.css', import.meta.url).href;

function ensureStylesheet() {
  const existing = document.querySelector(`link[data-plugin-ui="scheduler"][href="${STYLE_HREF}"]`);
  if (existing) return null;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  link.dataset.pluginUi = 'scheduler';
  document.head.appendChild(link);
  return link;
}

export function mountView(element, host) {
  const link = ensureStylesheet();
  const app = createApp(SchedulerPanel, { pluginHost: host ?? null });
  app.mount(element);
  return {
    unmount: () => {
      app.unmount();
      link?.remove();
    },
  };
}
