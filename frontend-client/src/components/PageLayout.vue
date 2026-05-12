<template>
  <div class="page-layout" :class="{ 'page-layout--embedded': embedded }">
    <header class="page-header">
      <div class="page-header__group page-header__group--meta">
        <button class="hamburger-menu-btn page-header__menu-btn" @click="openMobileSidebar" title="打开菜单">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div class="page-header__meta">
          <div class="page-header__title-row">
            <h1 class="page-header__title">{{ title }}</h1>
            <p v-if="subtitle" class="page-header__subtitle">{{ subtitle }}</p>
            <div v-if="$slots['header-hint']" class="page-header__hint-row">
              <slot name="header-hint" />
            </div>
          </div>
        </div>
      </div>

      <div class="page-header__group page-header__group--actions">
        <div class="page-header__actions">
          <div class="page-header__actions-main">
            <slot name="header-actions" />
          </div>
          <div v-if="hasHeaderMenu" ref="desktopMenuRef" class="page-header__menu-wrap">
            <UiIconButton
              class="page-header__more-btn"
              :class="{ 'is-open': desktopMenuOpen }"
              label="更多操作"
              title="更多操作"
              @click="desktopMenuOpen = !desktopMenuOpen"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="5" r="1" fill="currentColor" />
                <circle cx="12" cy="12" r="1" fill="currentColor" />
                <circle cx="12" cy="19" r="1" fill="currentColor" />
              </svg>
            </UiIconButton>
            <div v-if="desktopMenuOpen" class="page-header__menu-dropdown">
              <div class="page-header__menu-list">
                <slot name="header-menu" :close="() => { desktopMenuOpen = false }" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>

    <div class="page-shell" :style="shellStyle">
      <div class="page-mobile-nav">
        <button class="hamburger-menu-btn page-mobile-nav__menu" @click="openMobileSidebar" title="打开菜单">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div class="page-mobile-nav__copy">
          <span class="page-mobile-nav__title">{{ mobileTitle || title }}</span>
        </div>
        <button
          v-if="hasMobileMenu"
          ref="mobileMenuTriggerRef"
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

        <div v-if="hasMobileMenu && mobileMenuOpen" class="page-mobile-menu">
          <div ref="mobileMenuRef" class="page-mobile-menu__list">
            <slot name="mobile-menu" :close="() => { mobileMenuOpen = false }" />
          </div>
        </div>
      </div>

      <div class="page-content-scroll">
        <div class="page-content">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, ref, useSlots } from 'vue';
import { usePointerDownOutside } from '../composables/usePointerDownOutside';
import { UiIconButton } from './ui';

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
const hasHeaderMenu = computed(() => !!slots['header-menu']);
const mobileMenuOpen = ref(false);
const desktopMenuOpen = ref(false);
const desktopMenuRef = ref(null);
const mobileMenuRef = ref(null);
const mobileMenuTriggerRef = ref(null);

const shellStyle = computed(() => ({
  '--page-shell-max-width': props.maxWidth,
  '--page-content-padding': props.contentPadding,
  '--page-mobile-content-padding': props.mobileContentPadding,
}));

const openMobileSidebar = () => {
  shellSidebarControl?.openMobileSidebar?.();
};

usePointerDownOutside({
  inside: [desktopMenuRef],
  enabled: () => desktopMenuOpen.value,
  onOutside: () => {
    desktopMenuOpen.value = false;
  },
});

usePointerDownOutside({
  inside: [mobileMenuRef, mobileMenuTriggerRef],
  enabled: () => mobileMenuOpen.value,
  onOutside: () => {
    mobileMenuOpen.value = false;
  },
});
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
}

.page-content {
  width: 100%;
  max-width: var(--page-shell-max-width, 1100px);
  min-height: 100%;
  margin: 0 auto;
  padding: var(--page-content-padding, var(--spacing-lg));
  display: flex;
  gap: var(--spacing-md);
  flex-direction: column;
}

.page-content:deep(> :first-child) {
  margin-top: 0;
}

/* ===== 桌面端 Header ===== */
.page-header {
  position: relative;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  pointer-events: none;
  padding: var(--top-bar-padding-y) var(--top-bar-padding-x);
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.page-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--top-bar-divider-left);
  right: var(--top-bar-divider-right);
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--color-border) 10%, var(--color-border) 90%, transparent);
  opacity: 1;
  pointer-events: none;
}

.page-header > * {
  pointer-events: auto;
}

.page-header__group {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px;
  border-radius: 12px;
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
  flex: 1 1 auto;
  justify-content: flex-start;
  max-width: min(64%, 760px);
}

.page-header__group--actions {
  flex: 0 1 auto;
  min-width: 0;
  justify-content: flex-end;
  align-self: center;
  max-width: min(36%, 520px);
}

.page-header__meta {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  align-items: center;
}

.page-header__title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  width: 100%;
}

.page-header__hint-row {
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  min-width: 0;
  margin-left: auto;
}

.page-header__menu-btn {
  display: var(--hamburger-display);
  flex-shrink: 0;
}

.page-header__title {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: 0;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.page-header__subtitle {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.page-header__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  align-content: center;
  gap: 6px;
  flex-wrap: nowrap;
  flex: 0 1 auto;
  max-width: 100%;
  min-width: 0;
}

.page-header__actions-main {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  align-content: center;
  gap: 6px;
  flex-wrap: nowrap;
  min-width: 0;
}

.page-header__menu-wrap {
  position: relative;
  flex: 0 0 auto;
  margin-left: 2px;
}

.page-header__more-btn {
  width: var(--icon-button-size-md);
  min-width: var(--icon-button-size-md);
  padding: 0;
}

.page-header__more-btn.is-open {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
}

.page-header__menu-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: var(--z-dropdown);
  min-width: 220px;
}

.page-header__menu-list {
  padding: 6px;
  border-radius: 12px;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-md);
}

.page-header__actions :deep(.custom-select) {
  width: clamp(136px, 15vw, 200px);
  flex: 0 1 200px;
  min-width: 0;
}

.page-header__actions :deep(.select-trigger) {
  height: var(--control-height-md);
  min-height: var(--control-height-md);
  padding: 0 34px 0 12px;
  border-radius: 8px;
  background: var(--color-hover-overlay);
  font-size: 12px;
  box-sizing: border-box;
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
  background: var(--color-glass-border);
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
  background: var(--color-interactive);
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
.page-mobile-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: var(--top-bar-padding-x);
  z-index: var(--z-dropdown);
  min-width: 220px;
}

.page-mobile-menu__list {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  box-shadow: var(--shadow-md);
  overflow: hidden;
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


@media (max-width: 1180px) {
  .page-header {
    gap: 10px;
  }

  .page-header__group--meta {
    max-width: 46%;
  }

  .page-header__group--actions {
    max-width: 54%;
    justify-content: flex-end;
    align-self: center;
  }

  .page-header__hint-row {
    display: none;
  }

  .page-header__subtitle {
    max-width: 180px;
    font-size: 11px;
  }

  .page-header__actions,
  .page-header__actions-main {
    justify-content: flex-end;
  }

  .page-header__actions :deep(.custom-select) {
    width: 144px;
    flex-basis: 144px;
  }
}
</style>
