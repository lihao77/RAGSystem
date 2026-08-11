<template>
  <div class="page-layout" :class="{ 'page-layout--embedded': embedded }" :style="shellStyle">
    <header class="page-header">
      <div class="page-header__group page-header__group--meta">
        <Button
          class="page-header__menu-btn"
          variant="ghost"
          size="icon"
          aria-label="打开菜单"
          title="打开菜单"
          @click="openMobileSidebar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </Button>
        <div class="page-header__meta">
          <h1 class="page-header__title">{{ title }}</h1>
        </div>
      </div>
    </header>

    <div class="page-shell">
      <div class="page-mobile-nav">
        <Button
          class="page-mobile-nav__menu"
          variant="ghost"
          size="icon"
          aria-label="打开菜单"
          title="打开菜单"
          @click="openMobileSidebar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </Button>
        <div class="page-mobile-nav__copy">
          <span class="page-mobile-nav__title">{{ mobileTitle || title }}</span>
        </div>
        <DropdownMenu v-if="hasMobileMenu" v-model:open="mobileMenuOpen">
          <DropdownMenuTrigger as-child>
            <Button
              class="page-mobile-nav__more"
              :class="{ 'is-open': mobileMenuOpen }"
              variant="ghost"
              size="icon"
              aria-label="更多操作"
              title="更多操作"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="5" r="1" fill="currentColor" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
                <circle cx="12" cy="19" r="1" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent class="page-mobile-menu__list min-w-[220px]" align="end" :side-offset="4">
            <slot name="mobile-menu" :close="() => { mobileMenuOpen = false }" />
          </DropdownMenuContent>
        </DropdownMenu>
        <div v-else class="page-mobile-nav__spacer" />
      </div>

      <div class="page-content-scroll" :class="{ 'page-content-scroll--fill': fill }">
        <div class="page-content" :class="{ 'page-content--fill': fill }">
          <div v-if="subtitle || hasHeaderActions || hasHeaderMenu" class="page-content__topbar">
            <p v-if="subtitle" class="page-content__subtitle">{{ subtitle }}</p>
            <div v-if="hasHeaderActions || hasHeaderMenu" class="page-content__actions" :class="{ 'has-mobile-menu': hasMobileMenu }">
              <slot name="header-actions" />
              <div v-if="hasHeaderMenu" class="page-content__menu-wrap">
                <DropdownMenu v-model:open="desktopMenuOpen">
                  <DropdownMenuTrigger as-child>
                    <Button
                      class="page-content__more-btn"
                      :class="{ 'is-open': desktopMenuOpen }"
                      variant="ghost"
                      size="icon"
                      aria-label="更多操作"
                      title="更多操作"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="5" r="1" fill="currentColor" />
                        <circle cx="12" cy="12" r="1" fill="currentColor" />
                        <circle cx="12" cy="19" r="1" fill="currentColor" />
                      </svg>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="page-header__menu-list min-w-[220px]" align="end" :side-offset="8">
                    <slot name="header-menu" :close="() => { desktopMenuOpen = false }" />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, ref, useSlots } from 'vue';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from './ui/dropdown-menu';
import { Button } from './ui/button';

const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  mobileTitle: { type: String, default: '' },
  maxWidth: { type: String, default: '1400px' },
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
  contentPadding: { type: String, default: 'var(--spacing-xl)' },
  mobileContentPadding: { type: String, default: 'var(--spacing-xl) var(--spacing-md)' },
  /* 整页填充模式：page-content 钉满视口高度、page-content-scroll 不再滚动，
     由页面内部的 app-shell 自管滚动（如 AgentStudio 工作台）。 */
  fill: { type: Boolean, default: false },
});

const slots = useSlots();
const shellSidebarControl = inject('shellSidebarControl', null);
const hasMobileMenu = computed(() => !!slots['mobile-menu']);
const hasHeaderMenu = computed(() => !!slots['header-menu']);
const hasHeaderActions = computed(() => !!slots['header-actions']);
const mobileMenuOpen = ref(false);
const desktopMenuOpen = ref(false);

const shellStyle = computed(() => ({
  '--page-shell-max-width': props.maxWidth,
  '--page-content-padding': props.contentPadding,
  '--page-mobile-content-padding': props.mobileContentPadding,
}));

const openMobileSidebar = () => {
  shellSidebarControl?.openMobileSidebar?.();
};
</script>

<style scoped>
/* ===== 页面外壳 ===== */
.page-layout {
  min-height: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
  padding: 0;
}

.page-layout--embedded {
  min-height: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.page-shell {
  margin: 0;
  width: 100%;
  flex: 1;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.page-content-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* 画布 = 最深背景层(primary)：让 Card(elevated) 明显浮起。
     页面最多三层次：背景(primary) → Card(elevated) → 子项(tertiary)，背景与第二层必须区分 */
  /* background: var(--color-bg-primary); */
}

.page-content {
  width: 100%;
  max-width: var(--page-shell-max-width, 1400px);
  min-height: 100%;
  margin: 0 auto;
  padding: var(--page-content-padding, var(--spacing-xl));
  display: flex;
  gap: var(--spacing-lg);
  flex-direction: column;
}

/* 整页填充：钉满视口、自管滚动，子级 app-shell 用 flex:1 填满。
   只动高度，不动宽度——max-width/margin 居中沿用 .page-content 基线，
   保证与 .page-header 同列对齐、和其他页面一致。 */
.page-content-scroll--fill {
  overflow: hidden;
}
.page-content--fill {
  height: 100%;
  min-height: 0;
}

/* 顶部条：subtitle + actions 一行（从 page-header 下移到 page-content） */
.page-content__topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  flex-wrap: wrap;
}
.page-content__subtitle {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.4;
  flex: 1 1 auto;
  min-width: 0;
}
.page-content__actions {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  flex-shrink: 0;
}
.page-content__menu-wrap { position: relative; }
.page-content__more-btn.is-open {
  background: var(--color-hover-overlay-md);
}

.page-content:deep(> :first-child) {
  margin-top: 0;
}

/* ===== 桌面端 Header —— 与内容区同宽同对齐 ===== */
.page-header {
  position: relative;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-lg);
  pointer-events: none;
  /* 与 .page-content 用同一个 max-width + 居中，保证标题列与正文列严丝合缝 */
  width: 100%;
  max-width: var(--page-shell-max-width, 1400px);
  margin: 0 auto;
  padding: var(--spacing-md) var(--spacing-xl);
  box-sizing: border-box;
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.page-header::after {
  display: none;
}

.page-header > * {
  pointer-events: auto;
}

.page-header__group {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
  padding: 0;
  border-radius: 0;
  background-color: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border: none;
  box-shadow: none;
  transition: none;
}

.page-header__group:hover {
  box-shadow: none;
}

.page-header__group--meta {
  min-width: 0;
  flex: 0 1 auto;
  justify-content: flex-start;
}

.page-header__meta {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
}

.page-header__menu-btn {
  display: var(--hamburger-display);
  flex-shrink: 0;
}

.page-header__title {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.02em;
  line-height: 1.15;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.page-header__menu-list {
  padding: 6px;
  border-radius: var(--radius-lg);
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: var(--glass-border-width) var(--glass-border-style) var(--glass-border-color);
  box-shadow: var(--glass-shadow);
}

/* ===== 移动端导航栏 ===== */
.page-mobile-nav {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  min-height: var(--control-height-lg);
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  padding: var(--top-bar-padding-y) var(--top-bar-padding-x);
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.page-mobile-nav::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--top-bar-divider-left);
  right: var(--top-bar-divider-right);
  height: 1px;
  background: var(--color-border);
  opacity: 1;
}

.page-mobile-nav__menu,
.page-mobile-nav__more {
  width: var(--icon-button-size-sm);
  height: var(--icon-button-size-sm);
  border-radius: var(--control-radius);
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.2s;
}

.page-mobile-nav__menu:hover,
.page-mobile-nav__more:hover {
  background: var(--color-hover-overlay-md);
}

.page-mobile-nav__copy {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.page-mobile-nav__title {
  min-width: 0;
  max-width: 100%;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-mobile-nav__spacer {
  width: var(--icon-button-size-sm);
  flex-shrink: 0;
}

/* ===== 移动端下拉菜单 ===== */
.page-mobile-menu__list {
  max-height: min(70vh, 520px);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: var(--glass-border-width) var(--glass-border-style) var(--glass-border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--glass-shadow);
  padding: 6px;
}

/* ===== 响应式 ===== */
@media (max-width: 900px) {
  .page-layout {
    padding: 0;
  }

  .page-layout--embedded {
    padding: 0;
  }

  .page-header {
    display: none;
  }

  .page-mobile-nav {
    display: flex;
  }

  /* 移动端有 mobile-menu 时隐藏顶栏 actions（操作走三点菜单） */
  .page-content__actions.has-mobile-menu {
    display: none;
  }

  .page-shell {
    gap: 0;
    padding: 0;
  }

  .page-layout--embedded .page-shell {
    padding: 0;
  }

  .page-content-scroll {
    flex: 1;
    min-height: 0;
  }

  .page-content {
    min-height: 100%;
    padding: var(--page-mobile-content-padding, var(--spacing-md));
  }

  .page-header__menu-btn {
    display: inline-flex;
  }
}


 @media (max-width: 1200px) {
      .page-header {
    gap: var(--spacing-md);
  }

  .page-header__group--meta {
    max-width: none;
  }

  .page-header__title {
    font-size: 1.15rem;
  }
}
</style>
