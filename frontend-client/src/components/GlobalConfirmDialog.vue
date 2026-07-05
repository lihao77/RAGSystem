<template>
  <Dialog :open="state.visible" @update:open="onOpenChange">
    <DialogContent class="max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ state.title }}</DialogTitle>
        <DialogDescription v-if="state.message">{{ state.message }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="cancel">{{ state.cancelText }}</Button>
        <Button :variant="state.danger ? 'destructive' : 'default'" @click="accept">{{ state.confirmText }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
/**
 * 全局确认弹窗宿主。读 useConfirm 单例状态渲染，挂在 App 根(唯一实例)。
 * 点遮罩 / Esc / X / 取消键 → cancel(Resolve false)；确认键 → accept(Resolve true)。
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { useConfirm } from '../composables/useConfirm';

const { state, accept, cancel } = useConfirm();

function onOpenChange(open) {
  // Dialog 内部 open 转 false(点遮罩/Esc/X) → cancel。accept/cancel 已同步置 visible=false，守卫防重复 settle。
  if (!open && state.visible) cancel();
}
</script>
