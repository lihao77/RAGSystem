<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    title="管理中心"
    subtitle="集中进入模型、Agent、Team、MCP、知识库、监控、守护系统和系统配置。"
    mobile-title="管理中心"
    max-width="1180px"
    content-padding="var(--spacing-lg)"
    mobile-content-padding="var(--spacing-sm)"
  >
    <template #header-actions>
      <UiButton :as="RouterLink" class="admin-header-link" :to="chatReturnPath" title="返回工作台">
        返回工作台
      </UiButton>
    </template>

    <section class="admin-overview" aria-label="管理概览">
      <UiPanel as="article" class="admin-overview-item" tone="muted">
        <span class="admin-overview-item__label">管理入口</span>
        <strong>{{ managementNavItems.length }}</strong>
      </UiPanel>
      <UiPanel as="article" class="admin-overview-item" tone="muted">
        <span class="admin-overview-item__label">工作区</span>
        <strong>会话优先</strong>
      </UiPanel>
      <UiPanel as="article" class="admin-overview-item" tone="muted">
        <span class="admin-overview-item__label">旧路径</span>
        <strong>保留直达</strong>
      </UiPanel>
    </section>

    <section
      v-for="group in visibleGroups"
      :key="group.key"
      class="admin-section"
      :aria-labelledby="`admin-section-${group.key}`"
    >
      <div class="admin-section__head">
        <div>
          <h2 :id="`admin-section-${group.key}`">{{ group.label }}</h2>
          <p>{{ group.description }}</p>
        </div>
        <UiBadge class="admin-section__count">{{ group.items.length }}</UiBadge>
      </div>

      <div class="admin-card-grid">
        <UiPanel
          v-for="item in group.items"
          :key="item.key"
          :as="RouterLink"
          class="admin-card"
          :to="item.path"
          tone="shell"
          padding="none"
          interactive
        >
          <span class="admin-card__icon">
            <component :is="item.icon" />
          </span>
          <span class="admin-card__body">
            <span class="admin-card__title">{{ item.title }}</span>
            <span class="admin-card__description">{{ item.description }}</span>
          </span>
          <span class="admin-card__arrow" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </span>
        </UiPanel>
      </div>
    </section>
  </PageLayout>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import PageLayout from '../components/PageLayout.vue';
import { UiBadge, UiButton, UiPanel } from '../components/ui';
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

.admin-overview {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.admin-overview-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-hover-overlay);
}

.admin-overview-item__label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.admin-overview-item strong {
  min-width: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-lg);
  font-weight: 650;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.admin-section__head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.admin-section__head h2 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-lg);
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: 0;
}

.admin-section__head p {
  margin: 4px 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.45;
}

.admin-section__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: var(--color-interactive);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.admin-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.admin-card {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 96px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.38);
  color: var(--color-text-primary);
  text-decoration: none;
  transition: background var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
}

.admin-card:hover {
  border-color: var(--color-border-hover);
  background: var(--color-hover-overlay);
  transform: translateY(-1px);
}

.admin-card:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.admin-card__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-interactive);
  color: var(--color-text-primary);
}

.admin-card__body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.admin-card__title {
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-weight: 650;
  line-height: 1.25;
  letter-spacing: 0;
}

.admin-card__description {
  display: -webkit-box;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.45;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.admin-card__arrow {
  display: inline-flex;
  color: var(--color-text-muted);
}

@media (max-width: 900px) {
  .admin-header-link {
    display: none;
  }

  .admin-overview,
  .admin-card-grid {
    grid-template-columns: 1fr;
  }

  .admin-card {
    grid-template-columns: 38px minmax(0, 1fr) 18px;
    min-height: 88px;
    padding: 12px;
  }

  .admin-card__icon {
    width: 38px;
    height: 38px;
  }
}
</style>
