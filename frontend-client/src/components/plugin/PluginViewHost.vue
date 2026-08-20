<template>
  <div class="plugin-view-host">
    <div v-if="error" class="plugin-view-error" role="alert">
      <p class="plugin-view-error-title">插件视图加载失败</p>
      <p class="plugin-view-error-detail">{{ error }}</p>
      <Button variant="outline" size="sm" @click="mountPlugin">重试</Button>
    </div>
    <div v-else ref="containerRef" class="plugin-view-container" :class="{ 'is-loading': loading }">
      <!-- 插件在容器内自建 Vue app（bundle 自带运行时），宿主只提供 DOM 与上下文 -->
    </div>
  </div>
</template>

<script setup>
/**
 * 插件 view 宿主（plugin-ui-sdk 契约 apiVersion 1）。
 *
 * 动态 import 插件 bundle（同源 /api/<plugin>/ui/bundle.js），调用其导出的
 * mountView(container, hostContext) 完成挂载；bundle 自带 Vue 运行时，
 * 与宿主零共享实例，崩溃与卸载都不影响宿主应用。
 * hostContext.api 复用统一 http client（自动带登录态）；
 * hostContext.events 暴露本插件 plugin_event 最近一帧（只读）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { http } from '../../api/http.js';
import { pluginEventState } from '../../composables/usePluginEvents.js';
import { Button } from '../ui/button/index.ts';

const props = defineProps({
  pluginId: { type: String, required: true },
  entry: { type: String, required: true },
  bundleUrl: { type: String, required: true },
  /** ui manifest 中的原始 view 描述（route/entry/title 等）。 */
  view: { type: Object, default: null },
});

const containerRef = ref(null);
const loading = ref(true);
const error = ref('');

let unmountHandle = null;

const hostContext = {
  apiVersion: 1,
  pluginId: props.pluginId,
  view: props.view ?? { route: '', entry: props.entry },
  api: {
    get: (url, options) => http.get(url, options),
    post: (url, body, options) => http.post(url, body, options),
    put: (url, body, options) => http.put(url, body, options),
    patch: (url, body, options) => http.patch(url, body, options),
    del: (url, options) => http.del(url, options),
  },
  events: {
    latest: (event) => pluginEventState.latest.get(`${props.pluginId}:${event}`) ?? null,
  },
};

async function mountPlugin() {
  error.value = '';
  loading.value = true;
  unmountHandle?.unmount?.();
  unmountHandle = null;
  try {
    // @vite-ignore：bundle 是运行时 URL（后端伺服），不能进构建期分析
    const module = await import(/* @vite-ignore */ props.bundleUrl);
    if (typeof module?.mountView !== 'function') {
      throw new Error(`bundle 未导出 mountView(element, host)（${props.bundleUrl}）`);
    }
    if (!containerRef.value) return;
    unmountHandle = module.mountView(containerRef.value, hostContext) ?? null;
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(mountPlugin);

onBeforeUnmount(() => {
  unmountHandle?.unmount?.();
  unmountHandle = null;
});
</script>

<style scoped>
.plugin-view-host {
  width: 100%;
  min-height: 100%;
}

.plugin-view-container.is-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.plugin-view-container.is-loading::after {
  content: '加载插件视图…';
}

.plugin-view-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xl);
  margin: var(--spacing-lg) auto;
  max-width: 480px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  text-align: center;
}

.plugin-view-error-title {
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
}

.plugin-view-error-detail {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  word-break: break-all;
  margin: 0;
}
</style>
