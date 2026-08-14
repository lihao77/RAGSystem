<template>
  <Dialog :open="open" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[640px]">
      <DialogHeader>
        <div class="modal-title-block">
          <DialogTitle>资源列表</DialogTitle>
          <p>{{ server?.display_name || server?.name }}</p>
        </div>
      </DialogHeader>
      <EntityListLayout
        v-if="!resources.length"
        title="资源列表"
        empty-title="暂无资源"
        empty-hint="服务未声明 resources 能力面，或连接未成功"
      />
      <ul v-else class="tool-list">
        <li v-for="(resource, idx) in resources" :key="resource.uri || idx" class="tool-item">
          <div class="tool-item-head"><code class="tool-name">{{ resource.name }}</code><code class="tool-desc">{{ resource.uri }}</code></div>
          <p v-if="resource.description" class="tool-desc">{{ resource.description }}</p>
          <button class="adm-btn adm-btn--sm" @click="emit('toggleResource', resource)">{{ resource.expanded ? '收起' : (resource.loading ? '读取中...' : '读取内容') }}</button>
          <pre v-if="resource.expanded && resource.content" class="detail-code">{{ JSON.stringify(resource.content, null, 2) }}</pre>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// MCP 资源列表弹窗（只读，支持展开读取内容）。
import EntityListLayout from '../admin/EntityListLayout.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

defineProps({
  open: { type: Boolean, default: false },
  server: { type: Object, default: null },
  resources: { type: Array, default: () => [] },
});

const emit = defineEmits(['close', 'toggleResource']);
</script>
