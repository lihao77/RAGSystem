<template>
  <section class="new-chat-start" aria-label="新聊天起始页">
    <h1>{{ greeting }}，有什么想让我帮忙的吗</h1>
  </section>
</template>

<script setup>
import { computed } from 'vue';

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 9) return '早上好呀';
  if (hour < 12) return '上午好呀';
  if (hour < 14) return '中午好呀';
  if (hour < 18) return '下午好呀';
  return '晚上好呀';
});
</script>

<style scoped>
.new-chat-start {
  width: min(760px, 100%);
  margin: 0 auto;
  text-align: center;
  transition:
    opacity 280ms var(--ease-out-expo),
    transform 320ms var(--ease-out-expo),
    filter 320ms var(--ease-out-expo);
  animation: titleFadeIn 0.45s var(--ease-out-expo) both;
}

.new-chat-start h1 {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 30px;
  line-height: 1.3;
  font-weight: 500;
  letter-spacing: 0;
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
    align-self: center;
  }

  .new-chat-start h1 {
    font-size: 24px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .new-chat-start {
    animation: none !important;
    transition: none !important;
  }
}
</style>
