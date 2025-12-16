<template>
  <div class="wf-node" :class="nodeClass" @dblclick.stop="emit('open-config')">
    <div class="wf-node-title">{{ data?.label || data?.node_type }}</div>
    <div class="wf-node-sub">{{ data?.node_type }} · {{ id }}</div>

    <!-- 单输入/单输出：连接后在“连线编辑”里选择具体端口映射 -->
    <Handle type="target" :position="Position.Left" id="in" class="single-handle in" />
    <Handle type="source" :position="Position.Right" id="out" class="single-handle out" />

    <div class="io-tags">
      <span class="tag in">IN</span>
      <span class="tag out">OUT</span>
    </div>

    <div class="wf-node-footer">
      <span class="cfg" :class="{ empty: !data?.config_id }">{{ data?.config_id ? 'cfg: ' + data.config_id : '未选配置' }}</span>
      <button class="btn" @click.stop="emit('open-config')">配置</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['open-config']);

const nodeClass = computed(() => ({
  dim: !!props?.data?.ui?.dim,
  connectable: !!props?.data?.ui?.connectable,
  error: !!props?.data?.ui?.error,
}));


</script>

<style scoped>
.wf-node {
  position: relative;
  overflow: visible;
  width: 220px;
  border: 1px solid #dcdfe6;
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px 8px 12px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.06);
  transition: opacity .12s ease, box-shadow .12s ease, border-color .12s ease;
}
.wf-node.connectable {
  border-color: #409EFF;
  box-shadow: 0 2px 14px rgba(64,158,255,0.18);
}
.wf-node.dim {
  opacity: 0.35;
}
.wf-node.error {
  border-color: #f56c6c;
  box-shadow: 0 2px 14px rgba(245,108,108,0.18);
}
.wf-node-title { font-weight: 700; color: #303133; }
.wf-node-sub { margin-top: 2px; color: #909399; font-size: 12px; }
.wf-node-footer {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.cfg {
  font-size: 12px;
  color: #606266;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cfg.empty { color: #f56c6c; }
.single-handle {
  width: 15px;
  height: 15px;
  border-radius: 9px;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.12);
}
.single-handle.in { background: #67c23a; }
.single-handle.out { background: #409EFF; }

.io-tags {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
}
.tag {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 10px;
  border: 1px solid #ebeef5;
  background: rgba(255,255,255,0.9);
  color: #606266;
}
.tag.in { border-color: #c2e7b0; color: #67c23a; }
.tag.out { border-color: #b3d8ff; color: #409EFF; }

.btn {
  border: 1px solid #409EFF;
  background: #409EFF;
  color: #fff;
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 12px;
}
</style>
