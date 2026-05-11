<template>
  <section class="adm-panel">
    <header class="adm-panel__header">
      <div class="adm-panel__title-block">
        <h2 class="adm-panel__title">{{ title }}</h2>
        <p v-if="description" class="adm-panel__description">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="adm-panel__actions">
        <slot name="actions" />
      </div>
    </header>

    <div v-if="loading" class="adm-state">
      <div class="adm-spinner" aria-hidden="true"></div>
      <p>{{ loadingText }}</p>
    </div>

    <div v-else-if="error" class="adm-state adm-state--error">
      <slot name="error-icon" />
      <p>{{ error }}</p>
      <button v-if="retryable" class="pl-btn" @click="emit('retry')">{{ retryText }}</button>
    </div>

    <div v-else-if="empty" class="adm-state adm-state--empty">
      <slot name="empty-icon" />
      <p v-if="emptyTitle" class="adm-state__title">{{ emptyTitle }}</p>
      <p v-if="emptyHint" class="adm-state__hint">{{ emptyHint }}</p>
    </div>

    <slot v-else />
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  loadingText: { type: String, default: '加载中...' },
  error: { type: String, default: '' },
  empty: { type: Boolean, default: false },
  emptyTitle: { type: String, default: '' },
  emptyHint: { type: String, default: '' },
  retryable: { type: Boolean, default: true },
  retryText: { type: String, default: '重试' },
});

const emit = defineEmits(['retry']);
</script>
