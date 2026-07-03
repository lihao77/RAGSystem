<template>
  <div class="admin-layout">
    <aside class="admin-sidenav">
      <div class="admin-sidenav__head">
        <RouterLink to="/admin" class="admin-sidenav__title" title="管理中心概览">管理中心</RouterLink>
      </div>
      <nav class="admin-sidenav__nav" aria-label="管理导航">
        <section v-for="group in visibleGroups" :key="group.key" class="admin-sidenav__group">
          <div class="admin-sidenav__group-label">{{ group.label }}</div>
          <RouterLink
            v-for="item in group.items"
            :key="item.key"
            :to="item.path"
            class="admin-sidenav__item"
            :class="{ active: isActive(item) }"
            :title="item.title"
          >
            <component :is="item.icon" class="admin-sidenav__item-icon" />
            <span class="admin-sidenav__item-label">{{ item.label }}</span>
          </RouterLink>
        </section>
      </nav>
    </aside>
    <main class="admin-main">
      <slot />
    </main>
  </div>
</template>

<script setup>
defineOptions({ inheritAttrs: false });

import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { adminNavGroups, managementNavItems } from '../navigation/adminNavigation';

const route = useRoute();

const visibleGroups = computed(() => adminNavGroups
  .map((group) => ({
    ...group,
    items: managementNavItems.filter((item) => item.group === group.key),
  }))
  .filter((group) => group.items.length > 0));

const isActive = (item) => route.meta?.mainView === item.mainView;
</script>

<style scoped>
.admin-layout {
  display: flex;
  height: 100%;
  width: 100%;
  background: var(--color-bg-app);
  overflow: hidden;
}

.admin-sidenav {
  width: var(--admin-sidenav-width, 232px);
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: var(--color-bg-primary);
  overflow-y: auto;
  padding: var(--spacing-lg) var(--spacing-sm);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.admin-sidenav__head {
  padding: 0 var(--spacing-sm) var(--spacing-sm);
  border-bottom: 1px solid var(--color-border);
}

.admin-sidenav__title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 590;
  letter-spacing: -0.01em;
  text-decoration: none;
}

.admin-sidenav__title:hover {
  color: var(--color-brand-accent);
}

.admin-sidenav__nav {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.admin-sidenav__group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.admin-sidenav__group-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  padding: var(--spacing-xs) var(--spacing-sm);
  margin-bottom: 2px;
}

.admin-sidenav__item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--control-radius);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  text-decoration: none;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.admin-sidenav__item:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.admin-sidenav__item.active {
  background: var(--color-active-bg);
  color: var(--color-brand-accent);
}

.admin-sidenav__item-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.admin-sidenav__item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 移动端：隐藏左导航，右内容占满（靠 Cmd+K 命令面板或返回 AdminCenter 切换） */
@media (max-width: 899px) {
  .admin-sidenav {
    display: none;
  }
}
</style>
