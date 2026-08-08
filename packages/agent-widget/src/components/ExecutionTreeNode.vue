<template>
  <div class="rag-exec-item">
    <!-- intent 行 -->
    <div
      v-if="node.type === 'intent'"
      class="rag-exec-node rag-exec-intent"
      :style="{ paddingLeft: node.depth * 22 + 'px' }"
      @click="toggleFold(node.foldId)"
    >
      <span class="rag-exec-icon" v-html="TOOL_ICONS.lightbulb"></span>
      <span class="rag-exec-intent-text">{{ node.text }}</span>
      <span
        v-if="node.children && node.children.length"
        class="rag-exec-tail"
        :class="{ open: isOpen(node.foldId) }"
        v-html="CHEVRON_DOWN"
      ></span>
    </div>
    <!-- agent 行 -->
    <div
      v-else-if="node.type === 'agent'"
      class="rag-exec-node"
      :class="[`st-${node.status}`]"
      :style="{ paddingLeft: node.depth * 22 + 'px' }"
      @click="toggleFold(node.foldId)"
    >
      <span class="rag-exec-icon" v-html="getToolIcon(node.name, 'bot')"></span>
      <span class="rag-exec-name">{{ node.name }}</span>
      <span class="rag-exec-status">{{ agentSummary(node) }}</span>
      <span class="rag-exec-tail" :class="{ open: isOpen(node.foldId) }" v-html="CHEVRON_DOWN"></span>
    </div>
    <!-- tool 行 -->
    <div
      v-else
      class="rag-exec-node"
      :class="[`st-${node.tool.status}`]"
      :style="{ paddingLeft: node.depth * 22 + 'px' }"
      @click="toggleFold(node.tool.callId)"
    >
      <span class="rag-exec-icon" v-html="getToolIcon(node.tool.toolName)"></span>
      <span class="rag-exec-name">{{ node.tool.toolName }}</span>
      <span class="rag-exec-status">{{ toolSummary(node.tool) }}</span>
      <span class="rag-exec-tail" :class="{ open: isOpen(node.tool.callId) }" v-html="CHEVRON_DOWN"></span>
    </div>

    <!-- tool 展开详情：参数 + 结果（grid 0fr→1fr）-->
    <div
      v-if="node.type === 'tool'"
      class="rag-exec-detail-wrap"
      :class="{ 'is-open': isOpen(node.tool.callId) }"
      :style="{ marginLeft: (node.depth * 22 + 22) + 'px' }"
    >
      <div class="rag-exec-detail">
        <div class="rag-exec-detail-block">
          <span class="rag-exec-detail-label">参数</span>
          <pre class="rag-exec-detail-pre">{{ formatArgs(node.tool.arguments) }}</pre>
        </div>
        <div class="rag-exec-detail-block">
          <span class="rag-exec-detail-label">结果</span>
          <div class="rag-exec-detail-text" :class="{ 'is-error': node.tool.status === 'failed' }">{{ formatResult(node.tool) }}</div>
        </div>
      </div>
    </div>

    <!-- agent 展开详情：任务 + 结果（grid 0fr→1fr）-->
    <div
      v-if="node.type === 'agent' && (node.task || node.result)"
      class="rag-exec-detail-wrap"
      :class="{ 'is-open': isOpen(node.foldId) }"
      :style="{ marginLeft: (node.depth * 22 + 22) + 'px' }"
    >
      <div class="rag-exec-detail">
        <div v-if="node.task" class="rag-exec-detail-block">
          <span class="rag-exec-detail-label">任务</span>
          <div class="rag-exec-detail-text">{{ node.task }}</div>
        </div>
        <div v-if="node.result" class="rag-exec-detail-block">
          <span class="rag-exec-detail-label">结果</span>
          <div class="rag-exec-detail-text" :class="{ 'is-error': node.status === 'failed' }">{{ cleanObservation(node.result) }}</div>
        </div>
      </div>
    </div>

    <!-- 子节点容器（intent/agent）：grid 0fr→1fr 高度动画，与 tool/agent detail-wrap 同一类（单容器，流畅）。-->
    <div
      v-if="(node.type === 'intent' || node.type === 'agent') && node.children && node.children.length"
      class="rag-exec-children"
      :class="{ 'is-open': isOpen(node.foldId) }"
    >
      <div class="rag-exec-children-inner">
        <ExecutionTreeNode
          v-for="(child, i) in node.children"
          :key="child.foldId || (child.tool && child.tool.callId) || i"
          :node="child"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { inject } from "vue";
import { TOOL_ICONS, getToolIcon } from "../icons/toolIcons";

// 递归组件：name 用于模板内自引用 <ExecutionTreeNode>。
defineOptions({ name: "ExecutionTreeNode" });

defineProps({
  node: { type: Object, required: true },
});

// 折叠状态由 ChatPanel provide，全树共享一个 expanded Set。
const expanded = inject("execExpanded");
const toggleFold = inject("execToggle");
const isOpen = (id) => expanded.value.has(id);

const CHEVRON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

function agentSummary(node) {
  if (node.status === "failed") return "失败";
  if (node.status === "interrupted") return "已中断";
  return "";
}
function cleanObservation(raw) {
  if (!raw) return "";
  let text = String(raw);
  const tr = text.match(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/i);
  if (tr) text = tr[1];
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) text = cdata[1];
  text = text.replace(/<\/?(?:result|observation|output)[^>]*>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  text = text.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}
function toolSummary(tool) {
  if (tool.status === "running") return "运行中";
  if (tool.status === "failed") return "失败";
  if (tool.status === "interrupted") return "已中断";
  const obs = cleanObservation(tool.summary || tool.observation || "").replace(/\s+/g, " ").trim();
  if (!obs) return "完成";
  return obs.length > 36 ? `${obs.slice(0, 36)}…` : obs;
}
function formatArgs(args) {
  if (args === undefined || args === null) return "（无）";
  if (typeof args === "string") return args.trim() || "（无）";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
function formatResult(tool) {
  if (tool.status === "running") return "执行中…";
  const obs = cleanObservation(tool.observation || tool.summary || "");
  if (obs) return obs;
  if (tool.status === "failed") return "失败（无结果）";
  if (tool.status === "interrupted") return "已中断（无结果）";
  return "（无结果）";
}
</script>

<style scoped>
.rag-exec-item {
  display: flex;
  flex-direction: column;
}
/* 子节点容器：grid 0fr→1fr 高度动画（与 tool/agent detail-wrap 同一类，单容器，流畅不卡）。*/
.rag-exec-children {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.22s var(--ease-spring, cubic-bezier(0.16, 1, 0.3, 1));
}
.rag-exec-children.is-open {
  grid-template-rows: 1fr;
}
.rag-exec-children-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
