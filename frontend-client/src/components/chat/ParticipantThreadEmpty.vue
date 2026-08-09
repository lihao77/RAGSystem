<template>
  <Empty class="participant-thread-empty">
    <EmptyHeader>
      <EmptyMedia variant="icon"><MessagesSquare /></EmptyMedia>
      <EmptyTitle>暂无对话记录</EmptyTitle>
      <EmptyDescription>{{ participant?.display_name || '该智能体' }}尚未产生可显示的消息</EmptyDescription>
    </EmptyHeader>
  </Empty>
</template>

<script setup>
import { MessagesSquare } from 'lucide-vue-next';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

defineProps({ participant: { type: Object, default: null } });
</script>

<style scoped>
.participant-thread-empty {
  min-height: 320px;
}
</style>
