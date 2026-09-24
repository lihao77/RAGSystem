<template>
  <div class="file-csv-table" :style="containerStyle">
    <table v-if="table.headers.length">
      <thead>
        <tr>
          <th class="file-csv-table__index">#</th>
          <th v-for="(header, index) in table.headers" :key="index" :title="header">{{ header }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, rowIndex) in table.rows" :key="rowIndex">
          <td class="file-csv-table__index">{{ rowIndex + 1 }}</td>
          <td v-for="(cell, cellIndex) in row" :key="cellIndex" :title="cell">{{ cell }}</td>
          <!-- 行长度不足表头时补齐，保持列对齐 -->
          <td v-for="cellIndex in Math.max(0, table.headers.length - row.length)" :key="`pad-${cellIndex}`"></td>
        </tr>
      </tbody>
    </table>
    <div v-else class="file-csv-table__empty">空表格</div>
    <div class="file-csv-table__foot" role="note">
      <span>共 {{ table.totalRows }} 行 · {{ table.headers.length }} 列</span>
      <span v-if="table.truncated">，仅展示前 {{ table.shownRows }} 行</span>
      <span v-if="truncated">，文件较大，统计基于截断后的内容</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { parseCsvTable } from './csvParse.js';

const props = defineProps({
  text: { type: String, default: '' },
  delimiter: { type: String, default: ',' },
  maxRows: { type: Number, default: Infinity },
  /** 输入文本在解码层已被截断（行数统计因此不完整）。 */
  truncated: { type: Boolean, default: false },
  /** 容器最大高度（px），0 表示不限制。 */
  maxHeight: { type: Number, default: 0 },
});

const table = computed(() => parseCsvTable(props.text, {
  delimiter: props.delimiter,
  maxRows: props.maxRows,
}));

const containerStyle = computed(() => (props.maxHeight > 0
  ? { maxHeight: `${props.maxHeight}px`, overflowY: 'auto' }
  : undefined));
</script>

<style scoped>
.file-csv-table {
  overflow-x: auto;
  scrollbar-width: thin;
}
.file-csv-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
  font-variant-numeric: tabular-nums;
}
.file-csv-table th,
.file-csv-table td {
  max-width: 260px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-primary);
}
.file-csv-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
  font-weight: 600;
}
.file-csv-table tbody tr:hover td { background: var(--color-hover-overlay); }
.file-csv-table__index {
  width: 1%;
  min-width: 40px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: right;
}
.file-csv-table__foot {
  position: sticky;
  bottom: 0;
  padding: 6px 12px;
  background: var(--color-bg-elevated);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}
.file-csv-table__empty {
  padding: 24px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
</style>
