<template>
  <Dialog :open="open" @update:open="onUpdateOpen">
    <DialogContent :class="contentClass">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">{{ description }}</DialogDescription>
      </DialogHeader>

      <form class="form-dialog__body" @submit.prevent="emit('submit')">
        <slot />
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </form>

      <DialogFooter>
        <Button variant="outline" @click="close">{{ cancelText }}</Button>
        <Button :disabled="busy || confirmDisabled" @click="emit('submit')">
          <Spinner v-if="busy" data-icon="inline-start" />
          {{ confirmText }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// 「字段 + 错误 + 双按钮」表单弹窗壳：统一 SkillLibrary / MCP / Provider 的弹窗形态。
// 字段区通过默认插槽填充（建议用 ui/field 的 FieldGroup + Field）。
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  error: { type: String, default: '' },
  busy: { type: Boolean, default: false },
  confirmText: { type: String, default: '确定' },
  cancelText: { type: String, default: '取消' },
  confirmDisabled: { type: Boolean, default: false },
  contentClass: { type: [String, Array, Object], default: '' },
});

const emit = defineEmits(['update:open', 'submit']);

function onUpdateOpen(value) {
  emit('update:open', value);
}

function close() {
  emit('update:open', false);
}
</script>

<style scoped>
.form-dialog__body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
</style>
