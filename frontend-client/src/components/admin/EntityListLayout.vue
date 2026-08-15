<template>
  <Card>
    <CardHeader class="flex flex-row items-start justify-between gap-4 space-y-0">
      <div class="space-y-1">
        <CardTitle>{{ title }}</CardTitle>
        <CardDescription v-if="description">{{ description }}</CardDescription>
      </div>
      <div v-if="$slots.actions">
        <slot name="actions" />
      </div>
    </CardHeader>
    <CardContent>
      <div v-if="loading" class="g-skeleton-rows" aria-busy="true" aria-live="polite">
        <span class="sr-only">{{ loadingText }}</span>
        <div v-for="n in 6" :key="n" class="g-skeleton-row">
          <div class="g-skeleton-bar g-skeleton-bar--avatar" aria-hidden="true"></div>
          <div class="g-skeleton-bar g-skeleton-bar--title" aria-hidden="true"></div>
          <div class="g-skeleton-bar g-skeleton-bar--sub" aria-hidden="true"></div>
        </div>
      </div>

      <div v-else-if="error" class="adm-state adm-state--error">
        <slot name="error-icon" />
        <p>{{ error }}</p>
        <Button v-if="retryable" variant="secondary" @click="emit('retry')">{{ retryText }}</Button>
      </div>

      <div v-else-if="empty" class="adm-state adm-state--empty">
        <slot name="empty-icon" />
        <p v-if="emptyTitle" class="adm-state__title">{{ emptyTitle }}</p>
        <p v-if="emptyHint" class="adm-state__hint">{{ emptyHint }}</p>
      </div>

      <slot v-else />
    </CardContent>
  </Card>
</template>

<script setup>
import { Button } from '../ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../ui/card';

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
