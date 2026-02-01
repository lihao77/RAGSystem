<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    :class="['icon-logo', { 'with-animation': animated }]"
  >
    <!-- 外圈渐变圆环 -->
    <circle cx="50" cy="50" r="45" :stroke="`url(#${gradientId}-1)`" stroke-width="2" opacity="0.6" />
    <circle v-if="!simple" cx="50" cy="50" r="38" :stroke="`url(#${gradientId}-2)`" stroke-width="1.5" opacity="0.4" />

    <!-- 中心节点 -->
    <circle cx="50" cy="50" r="12" :fill="`url(#${gradientId}-3)`" />

    <!-- 三个环绕节点 -->
    <circle cx="50" cy="25" r="6" :fill="`url(#${gradientId}-4)`" />
    <circle cx="71.65" cy="62.5" r="6" :fill="`url(#${gradientId}-4)`" />
    <circle cx="28.35" cy="62.5" r="6" :fill="`url(#${gradientId}-4)`" />

    <!-- 连接线 -->
    <line x1="50" y1="38" x2="50" y2="31" :stroke="`url(#${gradientId}-5)`" stroke-width="2" stroke-linecap="round" />
    <line x1="56.93" y1="57.5" x2="65.65" y2="62.5" :stroke="`url(#${gradientId}-5)`" stroke-width="2" stroke-linecap="round" />
    <line x1="43.07" y1="57.5" x2="34.35" y2="62.5" :stroke="`url(#${gradientId}-5)`" stroke-width="2" stroke-linecap="round" />

    <!-- 数据流动效果 (可选) -->
    <circle v-if="animated" cx="50" cy="32" r="2" fill="#60a5fa" opacity="0.8">
      <animate attributeName="cy" values="32;42" dur="1.5s" repeatCount="indefinite" />
      <animate attributeName="opacity" values="0.8;0" dur="1.5s" repeatCount="indefinite" />
    </circle>

    <defs>
      <linearGradient :id="`${gradientId}-1`" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#6366f1;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#8b5cf6;stop-opacity:1" />
      </linearGradient>
      <linearGradient :id="`${gradientId}-2`" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#60a5fa;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#6366f1;stop-opacity:1" />
      </linearGradient>
      <linearGradient :id="`${gradientId}-3`" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#6366f1;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#8b5cf6;stop-opacity:1" />
      </linearGradient>
      <linearGradient :id="`${gradientId}-4`" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#60a5fa;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#6366f1;stop-opacity:1" />
      </linearGradient>
      <linearGradient :id="`${gradientId}-5`" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#6366f1;stop-opacity:0.6" />
        <stop offset="100%" style="stop-color:#8b5cf6;stop-opacity:0.6" />
      </linearGradient>
    </defs>
  </svg>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  size: {
    type: [Number, String],
    default: 32
  },
  animated: {
    type: Boolean,
    default: false
  },
  simple: {
    type: Boolean,
    default: false
  }
});

// 生成唯一的 gradient ID，避免多个实例冲突
const gradientId = computed(() => `logo-gradient-${Math.random().toString(36).substr(2, 9)}`);
</script>

<style scoped>
.icon-logo {
  flex-shrink: 0;
  filter: drop-shadow(0 2px 8px rgba(99, 102, 241, 0.3));
  transition: all 0.3s ease;
}

.icon-logo.with-animation {
  animation: logoFloat 3s ease-in-out infinite;
}

@keyframes logoFloat {
  0%, 100% {
    transform: translateY(0px);
  }
  50% {
    transform: translateY(-10px);
  }
}
</style>
