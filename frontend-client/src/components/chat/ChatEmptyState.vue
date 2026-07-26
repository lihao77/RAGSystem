<template>
  <section class="new-chat-start" aria-label="新聊天起始页">
    <div class="new-chat-start__eyebrow">New chat</div>
    <h1>想让 Agent 做什么？</h1>
    <p>代码库、知识库、自动化任务，先定一个清晰目标。</p>
    <div v-if="$slots.setup" class="new-chat-setup">
      <slot name="setup" />
    </div>
  </section>
</template>

<script setup>
// 起始页只保留标题 + 启动设置；快捷 prompt 卡片已移除
</script>

<style scoped>
.new-chat-start {
  width: min(800px, 100%);
  margin: 0 auto;
  text-align: left;
  transition:
    opacity 280ms var(--ease-out-expo),
    transform 320ms var(--ease-out-expo),
    filter 320ms var(--ease-out-expo);
  animation: titleFadeIn 0.45s var(--ease-out-expo) both;
}

.new-chat-start__eyebrow {
  margin-bottom: 12px;
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.new-chat-start h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: clamp(32px, 5vw, 54px);
  line-height: 1.04;
  font-weight: 760;
  letter-spacing: 0;
}

.new-chat-start p {
  max-width: 560px;
  margin: 14px 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  line-height: 1.7;
}

.new-chat-setup {
  margin-top: 24px;
}

@keyframes titleFadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 767px) {
  .new-chat-start {
    align-self: flex-start;
  }

  .new-chat-start h1 {
    font-size: 34px;
  }

  .new-chat-setup {
    margin-top: 20px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .new-chat-start {
    animation: none !important;
    transition: none !important;
  }
}
</style>
