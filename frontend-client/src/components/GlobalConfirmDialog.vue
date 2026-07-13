<template>
  <AlertDialog :open="state.visible">
    <AlertDialogContent class="max-w-[420px]">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ state.title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="state.message">{{ state.message }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <Button variant="ghost" @click="cancel">{{ state.cancelText }}</Button>
        <Button :variant="state.danger ? 'destructive' : 'default'" @click="accept">{{ state.confirmText }}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup>
/**
 * 全局确认弹窗宿主。读 useConfirm 单例状态渲染，挂在 App 根(唯一实例)。
 * 用 AlertDialog（而非 Dialog）：alertdialog 语义让读屏念到 title + description，
 * 遮罩点击/ESC 不再关闭，强制用户在 取消/确认 间显式选择（防误点遮罩跳过确认）。
 * 取消键 → cancel(resolve false)；确认键 → accept(resolve true)。
 */
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from './ui/alert-dialog';
import { Button } from './ui/button';
import { useConfirm } from '../composables/useConfirm';

const { state, accept, cancel } = useConfirm();
</script>
