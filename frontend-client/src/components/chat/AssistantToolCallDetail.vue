<template>
  <div class="tool-call-detail">
    <!-- 错误摘要只配终端/diff 视图：这两种视图不解析 payload.error，横幅是唯一能说明
        失败原因的地方。通用分支的结果块已带 is-error 红底并承载完整错误文本（与非工具
        步骤的任务/结果块形态一致），再叠一条首行摘要就是同话两说。 -->
    <div v-if="errorText && (terminalView || diffView)" class="tool-call-detail-error">{{ errorText }}</div>

    <!-- execute_shell（兼容退役名 execute_bash）：终端风格（红黄绿灯 + $ 提示符 + stdout/stderr 分流着色） -->
    <div v-if="terminalView" class="tool-terminal markdown-body">
      <div class="tool-terminal__chrome">
        <span class="tool-terminal__dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tool-terminal__title">{{ terminalView.title || 'bash' }}</span>
        <span v-if="terminalView.workingDir" class="tool-terminal__dir" :title="terminalView.workingDir">
          {{ terminalView.workingDir }}
        </span>
        <span
          v-if="exitBadge"
          class="tool-terminal__exit"
          :class="{ 'is-error': terminalView.exitCode !== 0 }"
        >
          exit {{ terminalView.exitCode }}
        </span>
      </div>
      <div class="tool-terminal__body">
        <div v-if="terminalView.description" class="tool-terminal__desc">{{ terminalView.description }}</div>
        <div v-if="terminalView.command" class="tool-terminal__command">
          <span class="tool-terminal__prompt" aria-hidden="true">$</span>
          <pre class="tool-terminal__pre"><code v-html="commandHtml"></code></pre>
        </div>
        <div v-if="toolRunning" class="tool-terminal__running">
          <span class="tool-terminal__cursor" aria-hidden="true"></span>执行中...
        </div>
        <template v-else-if="terminalView.backgroundStarted">
          <div class="tool-terminal__background">
            已转入后台执行<template v-if="terminalView.backgroundId"> · 任务 {{ terminalView.backgroundId }}</template>
            <template v-if="terminalView.backgroundOutputPath"> · 输出 {{ terminalView.backgroundOutputPath }}</template>
          </div>
        </template>
        <template v-else>
          <pre v-if="terminalView.stdout" class="tool-terminal__pre tool-terminal__stdout"><code>{{ terminalView.stdout }}</code></pre>
          <pre v-if="terminalView.stderr" class="tool-terminal__pre tool-terminal__stderr"><code>{{ terminalView.stderr }}</code></pre>
          <div v-if="!terminalView.command && !terminalView.stdout && !terminalView.stderr" class="tool-terminal__empty">
            （无输出）
          </div>
        </template>
      </div>
    </div>

    <!-- edit_file：diff 风格（行号 + +/- 标记 + 增删行着色，同 FileChangesPanel 视觉语系） -->
    <div v-else-if="diffView" class="tool-diff">
      <div class="tool-diff__head">
        <span class="tool-diff__file" :title="diffView.filePath">
          {{ diffView.fileName || diffView.filePath || '文件差异' }}
        </span>
        <span class="tool-diff__stats" aria-label="行变更统计">
          <span class="is-added">+{{ diffView.added }}</span>
          <span class="is-removed">-{{ diffView.removed }}</span>
        </span>
        <span v-if="diffView.replacements != null" class="tool-diff__count">{{ diffView.replacements }} 处替换</span>
      </div>
      <div v-if="diffView.lines.length" class="tool-diff__lines">
        <div
          v-for="(line, index) in diffView.lines"
          :key="index"
          class="tool-diff__line"
          :class="`is-${line.type}`"
        >
          <template v-if="line.type === 'hunk'">
            <span class="tool-diff__hunk">{{ line.text }}</span>
          </template>
          <template v-else>
            <span class="tool-diff__no">{{ line.lineNo ?? '' }}</span>
            <span class="tool-diff__mark" aria-hidden="true">{{ diffMark(line.type) }}</span>
            <span class="tool-diff__content">{{ line.text || ' ' }}</span>
          </template>
        </div>
        <div v-if="diffView.truncated" class="tool-diff__truncated">… 差异过长已截断</div>
      </div>
      <div v-else class="tool-diff__empty">无行级差异</div>
    </div>

    <!-- 其余工具：参数 + 结果。特殊工具（bash 终端 / edit diff）之外不做
        per-tool 分段适配，信息密度和形态保持统一。 -->
    <template v-else>
      <div class="tool-call-detail-block">
        <span class="tool-call-detail-label">参数</span>
        <pre class="tool-call-detail-text is-mono">{{ formattedArguments }}</pre>
      </div>
      <div class="tool-call-detail-block">
        <span class="tool-call-detail-label">结果</span>
        <div class="tool-call-detail-text" :class="{ 'is-error': isError }">{{ resultText }}</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { renderHighlightedCode } from '../../utils/markdown.js';
import {
  getToolDiffView,
  getToolErrorText,
  getToolFallbackText,
  getToolTerminalView,
} from '../../utils/toolPresentation.js';
import { normalizeExecutionStatus } from '../../utils/executionTreePresentation.js';

defineOptions({ name: 'AssistantToolCallDetail' });

const props = defineProps({
  node: { type: Object, required: true },
  running: { type: Boolean, default: false },
});

const emit = defineEmits(['notify']);

const status = computed(() => normalizeExecutionStatus(props.node.status));
const isError = computed(() => status.value === 'error');
const errorText = computed(() => (isError.value ? getToolErrorText(props.node) : ''));

const terminalView = computed(() => getToolTerminalView(props.node));
const diffView = computed(() => getToolDiffView(props.node));
/* 工具运行态以节点自身 status 为准（run 级 running 只做门控）：run 进行中已完成的
   工具立即呈现结果与退出码，仅真正执行中的工具显示"执行中"；run 终态后因中断
   未收到 tool_result 而卡在 running 的节点，也不再永远显示执行中。 */
const toolRunning = computed(() => props.running && status.value === 'running');

const exitBadge = computed(() => Boolean(
  !toolRunning.value && terminalView.value && terminalView.value.exitCode != null,
));
const commandHtml = computed(() => (
  terminalView.value?.command ? renderHighlightedCode(terminalView.value.command, 'bash') : ''
));

const formattedArguments = computed(() => formatArguments(props.node.arguments));

const resultText = computed(() => (toolRunning.value
  ? '执行中...'
  : getToolFallbackText(props.node) || (isError.value ? '失败（无结果）' : '（无结果）')
));

// emit('notify') 目前无消费方，保留接口以兼容后续错误提示挂载
void emit;

function formatArguments(value) {
  if (value === undefined || value === null) return '（无）';
  if (typeof value === 'string') return value.trim() || '（无）';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function diffMark(type) {
  if (type === 'added') return '+';
  if (type === 'removed') return '-';
  return ' ';
}
</script>

<style scoped>
.tool-call-detail {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 8px;
}

.tool-call-detail-block {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.tool-call-detail-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  font-weight: 600;
}

.tool-call-detail-text {
  max-height: var(--detail-max-height);
  margin: 0;
  overflow: auto;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
  padding: 7px 9px;
  white-space: pre-wrap;
}

.tool-call-detail-text.is-mono {
  max-height: var(--detail-max-height-sm);
  font-family: var(--font-mono);
}

.tool-call-detail-text.is-error,
.tool-call-detail-error {
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.tool-call-detail-error {
  border-radius: var(--radius-sm);
  padding: 7px 9px;
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* ── 终端块 ─────────────────────────────────────────────
   主题自适应（遵循 token 规约），终端语义由红黄绿灯窗格 + $
   提示符 + stdout/stderr 分色承载；stdout 常规、stderr error。 */
.tool-terminal {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.55;
}

.tool-terminal__chrome {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-tertiary) 60%, var(--color-bg-primary));
}

.tool-terminal__dots {
  display: inline-flex;
  flex-shrink: 0;
  gap: 5px;
}

/* 红绿灯为跨主题固定装饰色（同 agent accent 的固定色用法） */
.tool-terminal__dots i {
  width: 9px;
  height: 9px;
  border-radius: var(--radius-full);
}

.tool-terminal__dots i:nth-child(1) { background: #ff5f57; }
.tool-terminal__dots i:nth-child(2) { background: #febc2e; }
.tool-terminal__dots i:nth-child(3) { background: #28c840; }

.tool-terminal__title {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-2xs);
  font-weight: 600;
}

.tool-terminal__dir {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-terminal__exit {
  flex-shrink: 0;
  margin-left: auto;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: rgba(var(--color-success-rgb), 0.14);
  color: var(--color-success);
  font-size: var(--font-size-2xs);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.tool-terminal__exit.is-error {
  background: rgba(var(--color-error-rgb), 0.14);
  color: var(--color-error);
}

.tool-terminal__body {
  display: flex;
  min-width: 0;
  /* 与 diff 同档：都是结构化的多行块 */
  max-height: var(--detail-max-height-lg);
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  padding: 8px 10px;
  background: var(--color-bg-secondary);
}

.tool-terminal__desc {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.tool-terminal__command {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.tool-terminal__prompt {
  flex-shrink: 0;
  color: var(--color-success);
  font-weight: 700;
  user-select: none;
}

.tool-terminal__command .tool-terminal__pre {
  color: var(--color-text-primary);
}

.tool-terminal__pre {
  min-width: 0;
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-terminal__stdout {
  color: var(--color-text-secondary);
}

.tool-terminal__stderr {
  color: var(--color-error);
}

.tool-terminal__running {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
}

.tool-terminal__cursor {
  display: inline-block;
  width: 7px;
  height: 12px;
  background: var(--color-text-secondary);
  animation: tool-terminal-blink 1s steps(2, start) infinite;
}

.tool-terminal__background,
.tool-terminal__empty {
  color: var(--color-text-muted);
}

/* ── diff 块 ────────────────────────────────────────────
   增删着色从 --color-success/error 用 color-mix 派生（token 规约）。 */
.tool-diff {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.tool-diff__head {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-tertiary) 60%, var(--color-bg-primary));
}

.tool-diff__file {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-2xs);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-diff__stats {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  margin-left: auto;
  font-size: var(--font-size-2xs);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.tool-diff__stats .is-added { color: var(--color-success); }
.tool-diff__stats .is-removed { color: var(--color-error); }

.tool-diff__count {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
}

.tool-diff__lines {
  max-height: var(--detail-max-height-lg);
  overflow: auto;
  padding-block: 2px;
  background: var(--color-bg-secondary);
}

.tool-diff__line {
  display: grid;
  grid-template-columns: 34px 14px minmax(0, 1fr);
  min-height: 17px;
}

.tool-diff__line.is-hunk {
  display: block;
  padding: 2px 10px 1px;
}

.tool-diff__hunk {
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  font-style: italic;
}

.tool-diff__no {
  padding-right: 6px;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
  font-variant-numeric: tabular-nums;
  text-align: right;
  user-select: none;
}

.tool-diff__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  user-select: none;
}

.tool-diff__content {
  padding-right: 10px;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-diff__line.is-added { background: color-mix(in srgb, var(--color-success) 8%, transparent); }
.tool-diff__line.is-removed { background: color-mix(in srgb, var(--color-error) 8%, transparent); }
.tool-diff__line.is-added .tool-diff__mark { color: var(--color-success); }
.tool-diff__line.is-removed .tool-diff__mark { color: var(--color-error); }

.tool-diff__truncated,
.tool-diff__empty {
  padding: 6px 10px;
  color: var(--color-text-muted);
  font-size: var(--font-size-2xs);
}

@keyframes tool-terminal-blink {
  to { visibility: hidden; }
}

@media (prefers-reduced-motion: reduce) {
  .tool-terminal__cursor {
    animation: none;
  }
}
</style>
