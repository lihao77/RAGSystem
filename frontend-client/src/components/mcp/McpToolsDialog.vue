<template>
  <Dialog :open="open" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[560px]">
      <DialogHeader>
        <div class="modal-title-block">
          <DialogTitle>工具列表</DialogTitle>
          <p>{{ serverName }}</p>
        </div>
      </DialogHeader>
      <EntityListLayout
        v-if="!tools.length"
        title="工具列表"
        empty-title="暂无工具"
        empty-hint="服务未声明任何工具，或连接未成功"
      />
      <ul v-else class="tool-list">
        <li v-for="(tool, idx) in tools" :key="tool.function?.name || idx" class="tool-item">
          <div class="tool-item-head">
            <code class="tool-name">{{ tool.function?.original_tool_name || tool.function?.name || '-' }}</code>
            <div class="tool-risk-select">
              <span class="tool-risk-label">风险</span>
              <CustomSelect :model-value="tool.function?.risk_level || 'medium'" :options="riskOptions" @update:model-value="emit('updateRisk', tool, $event)" />
            </div>
          </div>
          <p class="tool-desc">{{ tool.function?.description || '暂无描述' }}</p>
          <div v-if="tool.function?.annotations" class="tool-annotations">
            <span v-if="tool.function.annotations.readOnlyHint" class="anno-chip">只读</span>
            <span v-if="tool.function.annotations.destructiveHint" class="anno-chip anno-chip--warn">破坏性</span>
            <span v-if="tool.function.annotations.idempotentHint" class="anno-chip">幂等</span>
          </div>
          <div v-if="getToolMetrics(tool)" class="tool-metrics">
            调用 {{ getToolMetrics(tool).calls }} 次<span v-if="getToolMetrics(tool).failures"> · 失败 {{ getToolMetrics(tool).failures }}</span> · 平均 {{ Math.round(getToolMetrics(tool).total_duration_ms / getToolMetrics(tool).calls) }}ms
          </div>
          <div v-if="toolParameters(tool).length" class="tool-params">
            <div class="tool-params-label">参数</div>
            <div v-for="param in toolParameters(tool)" :key="param.name" class="param-row">
              <code class="param-name">{{ param.name }}</code>
              <span class="param-type">{{ param.type }}</span>
              <span v-if="param.required" class="param-required">必填</span>
              <span v-if="param.description" class="param-desc">{{ param.description }}</span>
            </div>
          </div>
        </li>
      </ul>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// MCP 工具列表弹窗（含按工具风险覆盖）。
import CustomSelect from '../ui/CustomSelect.vue';
import EntityListLayout from '../admin/EntityListLayout.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

defineProps({
  open: { type: Boolean, default: false },
  serverName: { type: String, default: '' },
  tools: { type: Array, default: () => [] },
  riskOptions: { type: Array, default: () => [] },
  getToolMetrics: { type: Function, required: true },
  toolParameters: { type: Function, required: true },
});

const emit = defineEmits(['close', 'updateRisk']);
</script>
