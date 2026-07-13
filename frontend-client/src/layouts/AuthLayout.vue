<template>
  <main id="main-content" class="flex min-h-full items-center justify-center bg-background px-4 py-10 text-foreground">
    <div class="flex w-full max-w-xl flex-col gap-6">
      <div class="flex items-center justify-center gap-3">
        <IconLogo :size="36" simple />
        <div>
          <div class="text-lg font-semibold">RAGSystem</div>
          <div class="text-sm text-muted-foreground">智能知识与 Agent 工作台</div>
        </div>
      </div>
      <slot />
    </div>
  </main>
</template>

<script setup>
import { IconLogo } from '../components/icons';
</script>
