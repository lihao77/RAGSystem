<template>
  <Dialog :open="open" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[560px]">
      <DialogHeader>
        <div class="modal-title-block">
          <DialogTitle>提示词列表</DialogTitle>
          <p>{{ server?.display_name || server?.name }}</p>
        </div>
      </DialogHeader>
      <EntityListLayout
        v-if="!prompts.length"
        title="提示词列表"
        empty-title="暂无提示词"
        empty-hint="服务未声明 prompts 能力面，或连接未成功"
      />
      <ul v-else class="tool-list">
        <li v-for="(prompt, idx) in prompts" :key="prompt.name || idx" class="tool-item">
          <div class="tool-item-head"><code class="tool-name">{{ prompt.name }}</code></div>
          <p class="tool-desc">{{ prompt.description || '暂无描述' }}</p>
          <div v-if="prompt.arguments?.length" class="tool-params">
            <div class="tool-params-label">参数</div>
            <div v-for="arg in prompt.arguments" :key="arg.name" class="param-row">
              <code class="param-name">{{ arg.name }}</code>
              <span v-if="arg.required" class="param-required">必填</span>
              <span v-if="arg.description" class="param-desc">{{ arg.description }}</span>
            </div>
          </div>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// MCP 提示词列表弹窗（只读）。
import EntityListLayout from '../admin/EntityListLayout.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

defineProps({
  open: { type: Boolean, default: false },
  server: { type: Object, default: null },
  prompts: { type: Array, default: () => [] },
});

const emit = defineEmits(['close']);
</script>
