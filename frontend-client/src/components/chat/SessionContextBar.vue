<template>
  <header
    class="session-context-bar top-controls-bar"
    :class="{ scrolled, 'is-sidebar-collapsed': showSidebarCollapsed }"
    aria-label="会话顶栏"
  >
    <div class="conversation-identity">
      <Button
        variant="ghost"
        size="icon-toolbar"
        class="sidebar-menu-trigger"
        aria-label="打开菜单"
        title="打开菜单"
        @click="emit('openMobileSidebar')"
      >
        <IconMenu />
      </Button>

      <span class="conversation-title" :title="sessionTitle">{{ sessionTitle }}</span>

      <!-- 会话动作紧跟在标题后面（OceanX 同款排布）：菜单作用于标题所指的这个会话，
           放到右侧末端会离它要操作的对象太远。 -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-toolbar" aria-label="更多会话操作" title="更多会话操作">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-52">
          <DropdownMenuLabel>会话操作</DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem
              :disabled="!currentSessionId"
              @select="emit('openFileChanges')"
            >
              <FileText />
              文件变更
            </DropdownMenuItem>
            <DropdownMenuItem
              :disabled="!currentSessionId || isExportingSession"
              @select="emit('exportSession')"
            >
              <Download />
              导出会话
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem @select="themeStore.toggle()">
              <Sun v-if="themeStore.isDark" />
              <Moon v-else />
              {{ themeStore.isDark ? '切换到亮色模式' : '切换到暗色模式' }}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- 这里不再挂"当前线程"智能体徽标：主对话列永远是根会话，子智能体身份由
           运行工作台的页签表达，挂在会话标题旁会读成"这段对话是它的"。 -->
      <SessionContextInfoButton
        v-if="currentSessionId"
        :current-session-id="currentSessionId"
        :team="team"
        :entry-agent="entryAgent"
        :workspace-root="workspaceRoot"
        :workspace-display="workspaceDisplay"
        :execution-status-text="executionStatusText"
        :show-execution-status="showExecutionStatus"
        :execution-observability="executionObservability"
        show-summary
        side="bottom"
        align="start"
      />
    </div>

    <div class="session-runtime-actions">
      <!-- 运行工作台的展开入口只在面板收起时出现（OceanX 同款交接）：面板展开时收起按钮
           在面板自己的表头里，两处并存会变成两个按钮管同一件事。
           运行概览本身（智能体 / 目标 / 后台任务）住在工作台卡里，表头不再挂状态胶囊。 -->
      <Button
        v-if="currentSessionId && !workbenchOpen"
        variant="ghost"
        size="icon-toolbar"
        title="展开运行工作台"
        aria-label="展开运行工作台"
        @click="emit('toggleWorkbench')"
      >
        <PanelRightOpen />
      </Button>
    </div>
  </header>
</template>

<script setup>
import { computed, inject, onUnmounted, ref } from 'vue';
import { Download, Ellipsis, FileText, Moon, PanelRightOpen, Sun } from 'lucide-vue-next';
import { IconMenu } from '../icons';
import { Button } from '../ui/button';
import { SIDEBAR_OVERLAY_QUERY } from '../../utils/breakpoints.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useThemeStore } from '../../stores/theme.js';
import SessionContextInfoButton from './SessionContextInfoButton.vue';

const themeStore = useThemeStore();
defineProps({
  currentSessionId: { type: String, default: '' },
  sessionTitle: { type: String, default: '新聊天' },
  isExportingSession: { type: Boolean, default: false },
  scrolled: { type: Boolean, default: false },
  team: { type: String, default: '' },
  entryAgent: { type: String, default: '' },
  workspaceRoot: { type: String, default: '' },
  workspaceDisplay: { type: String, default: '' },
  executionStatusText: { type: String, default: '' },
  showExecutionStatus: { type: Boolean, default: false },
  executionObservability: { type: Object, default: null },
  workbenchOpen: { type: Boolean, default: false },
});

const emit = defineEmits([
  'openMobileSidebar',
  'exportSession',
  'openFileChanges',
  'toggleWorkbench',
]);

// 桌面端侧栏折叠时，窗口左上角的固定浮钮（开关/新聊天）压住本栏左缘：
// 标题起点右移避让；移动端抽屉不涉及。
const sidebarCollapsed = inject('sidebarCollapsed', null);
const overlayQuery = typeof window !== 'undefined' ? window.matchMedia(SIDEBAR_OVERLAY_QUERY) : null;
const isMobileViewport = ref(Boolean(overlayQuery?.matches));
const onOverlayChange = (event) => { isMobileViewport.value = event.matches; };
overlayQuery?.addEventListener('change', onOverlayChange);
onUnmounted(() => overlayQuery?.removeEventListener('change', onOverlayChange));
const showSidebarCollapsed = computed(() => Boolean(sidebarCollapsed?.value) && !isMobileViewport.value);

</script>

<style scoped>
/* Electron 桌面端兼任标题栏：整栏可拖拽（被动文字随行），交互子元素排除；
   浏览器中 app-region 无效，不影响 Web 端。实底 --surface-shell 与右上角
   原生窗口控件条同色，按钮条融入背景；高度与其他顶栏行统一 44px
   （36px 图标按钮 + 上下 4px padding 的自然高度）。 */
.session-context-bar {
  position: relative;
  z-index: var(--z-sticky);
  display: flex;
  min-height: 44px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: var(--top-bar-padding-y) var(--top-bar-padding-x);
  background: var(--surface-shell);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition: background var(--transition-normal), padding-left var(--transition-normal);
  -webkit-app-region: drag;
  app-region: drag;
}

.session-context-bar :is(button, [role='button'], input, a) {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

.session-context-bar.scrolled {
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
}

.session-context-bar::after {
  opacity: 0;
}

.session-context-bar.scrolled::after {
  opacity: 1;
}

.conversation-identity {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
}

.conversation-title {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 650;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-runtime-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  /* Electron 右上角原生最小化/最大化/关闭按钮区让位（titlebar-area-width 之外即控件区宽度）；
     浏览器回退为 0 */
  padding-right: calc(100vw - env(titlebar-area-width, 100vw));
}

.sidebar-menu-trigger {
  display: none;
}

/* 桌面端侧栏折叠：左上角固定浮轨（开关 + 新聊天）覆盖本栏左缘，标题起点右移避让。
   让位宽度 = --sidebar-rail-reserve（浮轨宽 − 本栏内缩，定义在 MainLayout 的 .chat-layout）
   + 本栏常规内距，浮轨尺寸变化时自动跟上。 */
.session-context-bar.is-sidebar-collapsed {
  padding-left: calc(var(--sidebar-rail-reserve, 68px) + var(--top-bar-padding-x));
}

@media (min-width: 1025px) {
  .session-context-bar::after {
    opacity: 1;
  }
}

@media (max-width: 900px) {
  .session-context-bar {
    position: relative;
    inset: auto;
    min-height: 54px;
  }

  .sidebar-menu-trigger {
    display: inline-flex;
  }

  .conversation-title {
    color: var(--color-text-primary);
  }
}

@media (max-width: 480px) {
  .session-context-bar {
    gap: 6px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .session-context-bar {
    transition-duration: 1ms;
  }
}
</style>
