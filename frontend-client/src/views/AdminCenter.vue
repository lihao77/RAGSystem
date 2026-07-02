<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    title="管理中心"
    subtitle="配置模型、Agent、Team、工具、知识库与系统。"
    mobile-title="管理中心"
    max-width="1280px"
    content-padding="var(--spacing-2xl) var(--spacing-xl)"
    mobile-content-padding="var(--spacing-lg) var(--spacing-md)"
  >
    <template #header-actions>
      <UiButton :as="RouterLink" class="admin-header-link" :to="chatReturnPath" title="返回工作台" variant="ghost">
        返回工作台
      </UiButton>
    </template>

    <nav class="admin-nav" aria-label="管理导航">
      <section
        v-for="(group, gi) in visibleGroups"
        :key="group.key"
        class="admin-group"
        :class="{ 'admin-group--first': gi === 0 }"
        :aria-labelledby="`admin-group-${group.key}`"
      >
        <header class="admin-group__head">
          <div class="admin-group__head-text">
            <h2 :id="`admin-group-${group.key}`">{{ group.label }}</h2>
            <p>{{ group.description }}</p>
          </div>
          <span class="admin-group__count">{{ group.items.length }}</span>
        </header>

        <ul class="admin-list" role="list">
          <li v-for="item in group.items" :key="item.key" class="admin-list__item">
            <RouterLink :to="item.path" class="admin-entry">
              <span class="admin-entry__icon" aria-hidden="true">
                <component :is="item.icon" />
              </span>
              <span class="admin-entry__body">
                <span class="admin-entry__title">{{ item.title }}</span>
                <span class="admin-entry__desc">{{ item.description }}</span>
              </span>
              <span class="admin-entry__arrow" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
                </svg>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </nav>
  </PageLayout>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import PageLayout from '../components/PageLayout.vue';
import { UiButton } from '../components/ui';
import { adminNavGroups, managementNavItems } from '../navigation/adminNavigation';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const visibleGroups = computed(() => adminNavGroups
  .map((group) => ({
    ...group,
    items: managementNavItems.filter((item) => item.group === group.key),
  }))
  .filter((group) => group.items.length > 0));
</script>

<style scoped>
.admin-header-link {
  text-decoration: none;
}

/* ===== 分组导航 —— 全宽行 + 发丝分隔 + 大留白 ===== */
.admin-nav {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2xl);
}

.admin-group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

/* 分组标题：克制的小标签 + 计数 */
.admin-group__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 0 var(--spacing-xs);
  margin-bottom: var(--spacing-sm);
}

.admin-group__head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.admin-group__head-text h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.admin-group__head-text p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.admin-group__count {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

/* ===== 入口列表 —— 去卡片化，行间发丝线 ===== */
.admin-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.admin-list__item {
  border-top: 1px solid var(--color-border);
}

.admin-list__item:last-child {
  border-bottom: 1px solid var(--color-border);
}

/* 每个入口：全宽、幽灵态、hover 极浅底 */
.admin-entry {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--spacing-md);
  width: 100%;
  padding: var(--spacing-lg) var(--spacing-xs);
  text-decoration: none;
  color: var(--color-text-primary);
  transition: background var(--transition-fast), padding var(--transition-fast);
}

.admin-entry:hover {
  background: var(--color-hover-overlay-md);
  padding-left: var(--spacing-sm);
  padding-right: var(--spacing-sm);
}

.admin-entry:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: -2px;
  border-radius: var(--radius-sm);
}

/* 图标：线性、克制，与文本同色 */
.admin-entry__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  transition: color var(--transition-fast);
}

.admin-entry:hover .admin-entry__icon {
  color: var(--color-text-primary);
}

.admin-entry__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.admin-entry__title {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.005em;
}

.admin-entry__desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}

/* 箭头：默认隐去，hover 显现并向右滑动 */
.admin-entry__arrow {
  display: inline-flex;
  align-items: center;
  color: var(--color-text-muted);
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.admin-entry:hover .admin-entry__arrow {
  opacity: 1;
  transform: translateX(0);
  color: var(--color-brand-accent);
}

/* 移动端：图标列收窄、描述换行放开 */
@media (max-width: 600px) {
  .admin-entry {
    grid-template-columns: 22px minmax(0, 1fr) auto;
    gap: var(--spacing-sm);
    padding: var(--spacing-md) var(--spacing-xs);
  }

  .admin-entry__desc {
    -webkit-line-clamp: 2;
  }

  .admin-entry__arrow {
    display: none;
  }
}
</style>
