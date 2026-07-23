<template>
  <header class="session-context-bar top-controls-bar" :class="{ scrolled }" aria-label="会话顶栏">
    <div class="conversation-identity">
      <Button
        variant="ghost"
        size="icon"
        class="sidebar-menu-trigger"
        aria-label="打开菜单"
        title="打开菜单"
        @click="emit('openMobileSidebar')"
      >
        <IconMenu />
      </Button>

      <span class="conversation-title" :title="sessionTitle">{{ sessionTitle }}</span>
    </div>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button variant="ghost" size="icon" aria-label="更多会话操作" title="更多会话操作">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="w-52">
        <DropdownMenuLabel>会话操作</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            v-if="!isWideWorkbench"
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
  </header>
</template>

<script setup>
import { useMediaQuery } from '@vueuse/core';
import { Download, Ellipsis, FileText, Moon, Sun } from 'lucide-vue-next';
import { IconMenu } from '../icons';
import { Button } from '../ui/button';
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

const themeStore = useThemeStore();
const isWideWorkbench = useMediaQuery('(min-width: 1200px)');

defineProps({
  currentSessionId: { type: String, default: '' },
  sessionTitle: { type: String, default: '新聊天' },
  isExportingSession: { type: Boolean, default: false },
  scrolled: { type: Boolean, default: false },
});

const emit = defineEmits([
  'openMobileSidebar',
  'exportSession',
  'openFileChanges',
]);
</script>

<style scoped>
.session-context-bar {
  position: relative;
  z-index: var(--z-sticky);
  display: flex;
  min-height: 52px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: var(--top-bar-padding-y) var(--top-bar-padding-x);
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition: background var(--transition-normal);
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

.sidebar-menu-trigger {
  display: none;
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
