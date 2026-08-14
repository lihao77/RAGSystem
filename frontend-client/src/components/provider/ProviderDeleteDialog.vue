<template>
  <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[420px]">
      <DialogHeader>
        <DialogTitle>确认删除</DialogTitle>
        <DialogDescription>删除后，引用该 Provider 的 Agent 或知识库配置可能无法运行。</DialogDescription>
      </DialogHeader>
      <p class="delete-confirm-msg">确定要删除 Provider <strong>{{ deleteTarget ? getProviderKey(deleteTarget) : '' }}</strong> 吗？此操作不可撤销。</p>
      <p v-if="deleteUsageLoading" class="delete-usage-loading">正在检查引用关系...</p>
      <FieldError v-else-if="deleteUsageError">{{ deleteUsageError }}</FieldError>
      <div v-else-if="deleteUsages.length > 0" class="delete-usage-list">
        <strong>请先解除以下 {{ deleteUsages.length }} 个引用：</strong>
        <div v-for="usage in deleteUsages" :key="`${usage.kind}:${usage.key}:${usage.detail}`" class="delete-usage-item">
          <Badge variant="warning">{{ usageKindLabel(usage.kind) }}</Badge>
          <span>{{ usage.label }}</span>
          <small>{{ usage.detail }}</small>
        </div>
      </div>
      <DialogFooter>
        <Button size="sm" variant="outline" @click="emit('close')">取消</Button>
        <Button size="sm" variant="destructive" :disabled="deleting || deleteUsageLoading || !!deleteUsageError || deleteUsages.length > 0" @click="emit('confirm')">
          {{ deleting ? '删除中...' : deleteUsages.length > 0 ? '存在引用，无法删除' : '确认删除' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// Provider 删除确认弹窗：附带引用检查列表，存在引用时禁止删除。
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { FieldError } from '../ui/field';

defineProps({
  deleteTarget: { type: Object, default: null },
  deleteUsageLoading: { type: Boolean, default: false },
  deleteUsageError: { type: String, default: '' },
  deleteUsages: { type: Array, default: () => [] },
  deleting: { type: Boolean, default: false },
  getProviderKey: { type: Function, required: true },
  usageKindLabel: { type: Function, required: true },
});

const emit = defineEmits(['close', 'confirm']);
</script>
