<template>
  <div ref="bodyEl" class="group-collapse-body" :class="{ 'is-open': open }" :inert="!open">
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useCollapsibleHeight } from '@/composables/useCollapsibleHeight.js';

const props = defineProps<{ open?: boolean }>();

const bodyEl = ref<HTMLElement | null>(null);
// 与执行节点（AssistantExecutionNode）同一套高度动画：实测值驱动 max-height，
// 展开后释放上限为 none，收起前先钉回可视高度再收到 0。收起态用 inert 挡住
// 焦点/点击，不用 visibility——类切换瞬间 transition 规则同样在切换，
// visibility 可能按旧规则立即隐藏，内容会先消失再收高度。
useCollapsibleHeight(bodyEl, computed(() => Boolean(props.open)));
</script>

<style scoped>
/* 折叠容器：max-height 由 useCollapsibleHeight 内联驱动；展开稍长、收起略快（对齐执行节点节奏）。 */
.group-collapse-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height 180ms linear;
}

.group-collapse-body.is-open {
  transition: max-height 240ms linear;
}
</style>
