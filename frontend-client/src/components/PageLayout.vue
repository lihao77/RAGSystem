<template>
  <div class="page-layout" :class="{ 'page-layout--embedded': embedded }">
    <div class="page-shell" :style="shellStyle">

      <!-- 桌面端 Header -->
      <header class="page-header">
        <div class="page-header__meta">
          <div class="page-header__title-row">
            <button class="hamburger-menu-btn page-header__menu-btn" @click="openMobileSidebar" title="打开菜单">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
            <h1 class="page-header__title">{{ title }}</h1>
          </div>
          <p v-if="subtitle" class="page-header__subtitle">{{ subtitle }}</p>
          <slot name="header-hint" />
        </div>
        <div class="page-header__actions">
          <slot name="header-actions" />
        </div>
      </header>

      <!-- 移动端导航栏 -->
      <div class="page-mobile-nav">
        <button class="hamburger-menu-btn page-mobile-nav__menu" @click="openMobileSidebar" title="打开菜单">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span class="page-mobile-nav__title">{{ mobileTitle || title }}</span>
        <button
          v-if="hasMobileMenu"
          class="page-mobile-nav__more"
          :class="{ 'is-open': mobileMenuOpen }"
          @click="mobileMenuOpen = !mobileMenuOpen"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="5" r="1" fill="currentColor" />
            <circle cx="12" cy="12" r="1" fill="currentColor" />
            <circle cx="12" cy="19" r="1" fill="currentColor" />
          </svg>
        </button>
        <div v-else class="page-mobile-nav__spacer" />

        <!-- 移动端下拉菜单 -->
        <div v-if="hasMobileMenu && mobileMenuOpen" class="page-mobile-menu" @click="mobileMenuOpen = false">
          <div class="page-mobile-menu__list" @click.stop>
            <slot name="mobile-menu" :close="() => { mobileMenuOpen = false }" />
          </div>
        </div>
      </div>

      <!-- 主内容区 -->
      <slot />

    </div>
  </div>
</template>

<script setup>
import { computed, inject, ref, useSlots } from 'vue';

const props = defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  mobileTitle: { type: String, default: '' },
  maxWidth: { type: String, default: '1100px' },
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
  contentPadding: { type: String, default: 'var(--spacing-xl)' },
  mobileContentPadding: { type: String, default: 'var(--spacing-md)' },
});

const slots = useSlots();
const shellSidebarControl = inject('shellSidebarControl', null);
const hasMobileMenu = computed(() => !!slots['mobile-menu']);
const mobileMenuOpen = ref(false);

const shellStyle = computed(() => ({
  maxWidth: props.maxWidth,
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
  background: transparent;
  padding: var(--spacing-xl);
}

.page-layout--embedded {
  min-height: 100%;
  padding: var(--page-content-padding, var(--spacing-xl));
}

.page-shell {
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

/* ===== 桌面端 Header ===== */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacing-md);
  flex-wrap: wrap;
}

.page-header__meta {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.page-header__title-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.page-header__menu-btn {
  display: var(--hamburger-display);
}

.page-header__title {
  margin: 0;
  font-size: var(--font-size-3xl);
  font-weight: 700;
  color: var(--color-text-primary);
}

.page-header__subtitle {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.page-header__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
  flex-shrink: 0;
}

/* ===== 通用按钮 ===== */
.pl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  height: 40px;
  padding: 0 16px;
  border-radius: 20px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
  white-space: nowrap;
}

.pl-btn:hover:not(:disabled) {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
}

.pl-btn:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.pl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pl-btn--back {
  background: transparent;
}

/* ===== 移动端导航栏 ===== */
.page-mobile-nav {
  display: none;
  align-items: center;
  height: 52px;
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-lg);
  padding: 0 var(--spacing-sm);
}

.page-mobile-nav__menu,
.page-mobile-nav__more {
  width: 40px;
  height: 40px;
  border-radius: 50%;
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
  background: var(--color-interactive);
}

.page-mobile-nav__title {
  flex: 1;
  text-align: center;
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-mobile-nav__spacer {
  width: 40px;
  flex-shrink: 0;
}

/* ===== 移动端下拉菜单 ===== */
.page-mobile-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: var(--z-dropdown);
  min-width: 200px;
}

.page-mobile-menu__list {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  padding: 4px;
}

/* ===== 响应式 ===== */
@media (max-width: 900px) {
  .page-layout {
    padding: 0;
  }

  .page-layout--embedded {
    padding: var(--page-mobile-content-padding, var(--spacing-md));
  }

  .page-header {
    display: none;
  }

  .page-mobile-nav {
    display: flex;
  }

  .page-shell {
    gap: var(--spacing-md);
    padding: var(--spacing-md);
    padding-top: 0;
  }

  .page-layout--embedded .page-shell {
    padding-left: 0;
    padding-right: 0;
    padding-bottom: 0;
  }

  .page-header__menu-btn {
    display: inline-flex;
  }
}
</style>
