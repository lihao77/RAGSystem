<template>
  <div v-if="items.length" class="pending-followups" role="region" aria-label="待加入上下文的消息">
    <ol class="flex max-h-36 flex-col overflow-y-auto" aria-label="待加入上下文的消息">
      <li v-for="item in items" :key="item.request_id" class="pending-followup-row flex min-h-9 min-w-0 items-center gap-3">
        <Clock3 class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p class="min-w-0 flex-1 truncate text-sm" :title="item.content">{{ item.content }}</p>
        <span
          class="shrink-0 text-xs text-muted-foreground"
          :title="item.status === 'unconfirmed' ? '连接中断，暂时无法确认消息是否已处理，已保留原文。' : undefined"
        >{{ item.status === 'unconfirmed' ? '核对中…' : item.status === 'sending' ? '发送中…' : item.status === 'processing' ? '处理中…' : '等待处理' }}</span>
        <div class="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-xs" aria-label="编辑待处理消息" title="编辑"
            :disabled="!item.can_manage || item.mutating || item.status === 'unconfirmed'" @click="emit('edit', { ...item })">
            <Pencil data-icon="inline-start" />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="删除待处理消息" title="删除"
            :disabled="!item.can_manage || item.mutating || item.status === 'unconfirmed'" @click="emit('delete', { ...item })">
            <Trash2 data-icon="inline-start" />
          </Button>
        </div>
      </li>
    </ol>
  </div>
</template>

<script setup>
import { Clock3, Pencil, Trash2 } from 'lucide-vue-next';
import { Button } from '../ui/button';

defineProps({ items: { type: Array, default: () => [] } });
const emit = defineEmits(['edit', 'delete']);
</script>
