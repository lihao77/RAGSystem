<template>
  <!-- Windows 桌面端自绘窗口控件（titleBarStyle:'hidden' 后无原生按钮）：
       尺寸、圆角、hover 与应用内图标按钮同语言；固定于右上角，与 44px 顶栏行同一水平线。
       图标为统一几何的内联 SVG（12px 框、1px 描边）：lucide 各图标光学尺寸不一
       （Square 明显大于 Minus/X），自绘保证三颗视觉等大。 -->
  <div class="window-controls" aria-label="窗口控制">
    <button
      type="button"
      class="window-control-btn"
      title="最小化"
      aria-label="最小化"
      @click="minimize"
    >
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 6h9" /></svg>
    </button>
    <button
      type="button"
      class="window-control-btn"
      :title="isMaximized ? '还原' : '最大化'"
      :aria-label="isMaximized ? '还原' : '最大化'"
      @click="toggleMaximize"
    >
      <svg v-if="isMaximized" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4.5 1.5h6v6h-2" />
        <rect x="1.5" y="4.5" width="6" height="6" />
      </svg>
      <svg v-else viewBox="0 0 12 12" aria-hidden="true"><rect x="2" y="2" width="8" height="8" /></svg>
    </button>
    <button
      type="button"
      class="window-control-btn window-control-btn--close"
      title="关闭"
      aria-label="关闭"
      @click="closeWindow"
    >
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg>
    </button>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue';

const controls = window.ragsystemDesktop?.windowControls;
const isMaximized = ref(false);

// preload/main 热更不生效（需完全重启桌面端进程）：API 缺失或 IPC 无 handler 时
// 给明确报错，而不是静默没反应。
const invoke = (fn) => () => {
  try {
    const result = fn();
    result?.catch?.((error) => {
      console.error('[WindowControls] 窗口控制 IPC 失败——主进程为旧版，请完全退出并重启桌面端:', error);
    });
  } catch (error) {
    console.error('[WindowControls] 窗口控制不可用:', error);
  }
};
const minimize = invoke(() => controls?.minimize());
const toggleMaximize = invoke(() => controls?.toggleMaximize());
const closeWindow = invoke(() => controls?.close());

onMounted(async () => {
  // 各顶栏行右侧按控件组宽度预留位置（SessionContextBar / RunWorkbench / PageLayout
  // 的 padding-right 引用此变量；浏览器中组件不挂载，变量不设置，让位为 0）
  document.documentElement.style.setProperty('--window-controls-width', '100px');
  if (!controls) {
    console.error('[WindowControls] windowControls API 缺失——preload 为旧版，请完全退出并重启桌面端');
    return;
  }
  try {
    isMaximized.value = Boolean(await controls.isMaximized());
  } catch (error) {
    console.error('[WindowControls] 读取最大化状态失败（主进程为旧版，请重启桌面端）:', error);
  }
  controls.onMaximizedChange((value) => { isMaximized.value = value; });
});

onUnmounted(() => {
  document.documentElement.style.removeProperty('--window-controls-width');
});
</script>

<style scoped>
/* 顶栏行内容中心 ≈ 外壳内边距(spacing-xs) + 卡片边框 1px + 44px 行高的一半，
   控件组按同一几何对齐；容器兼任拖拽区（按钮自身排除）。
   z-index 取 modal 档：全屏遮罩之上窗口控件仍可用（与原生标题栏一致）。
   注意点击命中与 z-index 无关：drag 区域按 DOM 顺序折叠、后出现的赢，
   本组件必须挂在 #app 最后一个子节点（见 App.vue）。 */
.window-controls {
  position: fixed;
  top: calc(var(--spacing-xs, 4px) + 1px);
  right: var(--spacing-xs, 4px);
  z-index: var(--z-modal);
  display: flex;
  height: 44px;
  align-items: center;
  gap: 2px;
  padding: 0 6px 0 4px;
  -webkit-app-region: drag;
  app-region: drag;
}

.window-control-btn {
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.window-control-btn:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

/* 关闭保留 Windows 的红底语义，但底块收缩到与其他按钮相同的 28px 圆角块 */
.window-control-btn--close:hover {
  background: var(--color-danger);
  color: #fff;
}

.window-control-btn svg {
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
}
</style>
