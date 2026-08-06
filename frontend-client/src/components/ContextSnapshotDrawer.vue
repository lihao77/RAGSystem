<template>
  <Sheet :open="visible" @update:open="onOpenChange">
    <SheetContent side="right" class="flex w-[520px] max-w-[90vw] flex-col gap-0 p-0 sm:max-w-[520px]">
      <div class="ctx-drawer-header">
        <SheetTitle class="ctx-drawer-title">上下文快照</SheetTitle>
      </div>

      <div v-if="loading" class="ctx-loading"><span class="g-spinner"></span>加载中...</div>
      <div v-else-if="error" class="ctx-error">{{ error }}</div>
      <div v-else class="ctx-drawer-body">

        <!-- Token 统计 -->
        <section class="ctx-section">
          <h4>Token 用量</h4>
          <div class="ctx-token-bar-wrap">
            <div class="ctx-token-bar">
              <div class="ctx-token-fill" :style="{ width: tokenPct + '%' }"
                :class="tokenPct >= 90 ? 'danger' : tokenPct >= 70 ? 'warning' : ''"></div>
            </div>
            <span class="ctx-token-text">{{ data.token_stats.total_tokens.toLocaleString() }} / {{ data.token_stats.budget_tokens.toLocaleString() }} tokens</span>
          </div>
        </section>

        <!-- 配置 -->
        <section class="ctx-section">
          <h4>配置</h4>
          <div class="ctx-kv-list">
            <template v-for="(v, k) in data.config" :key="k">
              <div v-if="typeof v !== 'object' || v === null" class="ctx-kv">
                <span class="ctx-k">{{ k }}</span><span class="ctx-v">{{ v }}</span>
              </div>
              <div v-else class="ctx-kv ctx-kv-group">
                <span class="ctx-k">{{ k }}</span>
                <div class="ctx-kv-nested">
                  <div v-for="(sv, sk) in v" :key="sk" class="ctx-kv-sub">
                    <span class="ctx-k">{{ sk }}</span><span class="ctx-v">{{ sv }}</span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </section>

        <!-- Agent 工具 -->
        <section class="ctx-section">
          <h4>可用 Agent 工具 ({{ data.available_agent_tools.length }})</h4>
          <div v-for="tool in data.available_agent_tools" :key="tool.name" class="ctx-tool-item">
            <span class="ctx-tool-name">{{ tool.name }}</span>
          </div>
        </section>

        <!-- Master 直接工具 -->
        <section v-if="data.available_tools && data.available_tools.length" class="ctx-section">
          <h4>可直接调用的工具 ({{ data.available_tools.length }})</h4>
          <div v-for="tool in data.available_tools" :key="tool.name" class="ctx-tool-item">
            <span class="ctx-tool-name">{{ tool.name }}</span>
          </div>
        </section>

        <!-- Skills -->
        <section v-if="data.available_skills && data.available_skills.length" class="ctx-section">
          <h4>Skills ({{ data.available_skills.length }})</h4>
          <div v-for="skill in data.available_skills" :key="skill.name" class="ctx-tool-item">
            <span class="ctx-tool-name">{{ skill.name }}</span>
            <span class="ctx-v" style="margin-left: 6px;">{{ skill.description }}</span>
          </div>
        </section>

        <!-- System Prompt -->
        <section class="ctx-section">
          <h4>
            <button type="button" class="ctx-collapsible"
              :aria-expanded="spExpanded"
              aria-controls="ctx-system-prompt"
              @click="spExpanded = !spExpanded">
              System Prompt <span class="ctx-arrow" aria-hidden="true">{{ spExpanded ? '▼' : '▶' }}</span>
            </button>
          </h4>
          <pre v-if="spExpanded" id="ctx-system-prompt" class="ctx-code-block">{{ data.system_prompt }}</pre>
        </section>

        <!-- Memory -->
        <section v-if="data.memory" class="ctx-section">
          <h4>
            <button type="button" class="ctx-collapsible"
              :aria-expanded="memExpanded"
              aria-controls="ctx-memory"
              @click="memExpanded = !memExpanded">
              Memory (Stable Prefix) <span class="ctx-arrow" aria-hidden="true">{{ memExpanded ? '▼' : '▶' }}</span>
            </button>
          </h4>
          <div v-if="memExpanded" id="ctx-memory">
            <div v-if="data.memory.scope_capabilities && Object.keys(data.memory.scope_capabilities).length" class="ctx-kv-list" style="margin-bottom: 8px;">
              <div v-for="(caps, scope) in data.memory.scope_capabilities" :key="scope" class="ctx-kv ctx-kv-group">
                <span class="ctx-k">{{ scope }}</span>
                <div class="ctx-kv-nested">
                  <div v-for="(v, k) in caps" :key="k" class="ctx-kv-sub">
                    <span class="ctx-k">{{ k }}</span><span class="ctx-v">{{ v }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div v-for="(content, scope) in data.memory.indices" :key="scope" class="ctx-mem-scope">
              <div class="ctx-mem-scope-title">{{ scope }} Memory Index</div>
              <pre class="ctx-code-block ctx-mem-content">{{ content }}</pre>
            </div>
            <div v-if="!data.memory.indices || !Object.keys(data.memory.indices).length" class="ctx-v" style="font-size: var(--font-size-xs); color: var(--color-text-muted);">
              无已加载的记忆索引
            </div>
          </div>
        </section>

        <!-- 对话历史 -->
        <section class="ctx-section">
          <h4>对话历史 ({{ data.conversation_history.length }})</h4>
          <div class="ctx-history-list">
            <div v-for="(msg, i) in data.conversation_history" :key="i"
              class="ctx-history-item"
              :class="msgClass(msg)">
              <span class="ctx-role">{{ msgLabel(msg) }}</span>
              <span v-if="msg.react_intermediate" class="ctx-msg-type">R{{ msg.round || '' }}</span>
              <div class="ctx-content-preview">
                {{ msg.content_preview || '' }}
              </div>
              <div v-if="msg.tool_calls && msg.tool_calls.length" class="ctx-tool-calls">
                <div v-for="tc in msg.tool_calls" :key="tc.id || tc.function.name" class="ctx-tool-call">
                  <span class="ctx-tool-name">→ {{ tc.function.name }}</span>
                  <code class="ctx-tool-args">{{ tc.function.arguments }}</code>
                </div>
              </div>
            </div>
          </div>
        </section>

      </div>
    </SheetContent>
  </Sheet>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';

const props = defineProps({
  visible: Boolean,
  sessionId: String,
  selectedLlm: {
    type: String,
    default: '',
  },
  chatSdkClient: { type: Object, default: null },
});
const emit = defineEmits(['close']);

const loading = ref(false);
const error = ref('');
const data = ref(null);
const spExpanded = ref(false);
const memExpanded = ref(false);

function onOpenChange(open) {
  if (!open) emit('close');
}

const tokenPct = computed(() => {
  if (!data.value?.token_stats?.budget_tokens) return 0;
  return Math.min(100, Math.round(data.value.token_stats.total_tokens / data.value.token_stats.budget_tokens * 100));
});

function msgLabel(msg) {
  // 区分语义角色：中间轮（工具调用 intent / 工具结果 observation）显式标记，便于调试时分清
  // final answer / 用户消息 / 中间轮次。msg_type 来自存储语义，渲染后保留。
  if (msg.msg_type === 'observation') return 'Tool Result';
  if (msg.msg_type === 'intent') return 'Tool Call';
  if (msg.role === 'assistant') return 'Final Answer';
  return msg.role;
}

function msgClass(msg) {
  // 中间轮（intent/observation）用虚线样式与 final/user 实线区分。
  if (msg.msg_type === 'observation') return 'react-observation';
  if (msg.msg_type === 'intent') return 'react-thought';
  return 'role-' + msg.role;
}

async function fetchSnapshot() {
  loading.value = true;
  error.value = '';
  data.value = null;
  try {
    if (!props.chatSdkClient) throw new Error('Chat SDK 未初始化');
    const json = await props.chatSdkClient.getContextSnapshot(props.sessionId, { selectedLlm: props.selectedLlm });
    data.value = json.data;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.visible, (v) => { if (v) fetchSnapshot(); });
</script>

<style scoped>
.ctx-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--color-border, #e4e7ed); flex-shrink: 0; }
.ctx-drawer-title { margin: 0; font-size: var(--font-size-md); }
.ctx-drawer-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.ctx-loading, .ctx-error { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 40px; color: var(--color-text-muted); }
.ctx-error { color: var(--color-error); }
.ctx-section { margin-bottom: 18px; }
.ctx-section h4 { font-size: var(--font-size-sm); margin: 0 0 8px; color: var(--color-text-secondary); }
.ctx-token-bar-wrap { display: flex; align-items: center; gap: 10px; }
.ctx-token-bar { flex: 1; height: 8px; background: var(--color-bg-tertiary, #f0f0f0); border-radius: 4px; overflow: hidden; }
.ctx-token-fill { height: 100%; background: var(--color-success); border-radius: 4px; transition: width .3s; }
.ctx-token-fill.warning { background: var(--color-warning); }
.ctx-token-fill.danger { background: var(--color-error); }
.ctx-token-text { font-size: var(--font-size-xs); white-space: nowrap; color: var(--color-text-secondary); }
.ctx-kv-list { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.ctx-kv { font-size: var(--font-size-xs); }
.ctx-kv-group { width: 100%; }
.ctx-kv-nested { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 2px; padding-left: 12px; }
.ctx-kv-sub { font-size: var(--font-size-xs); }
.ctx-k { color: var(--color-text-muted); margin-right: 4px; }
.ctx-k::after { content: ':'; }
.ctx-v { color: var(--color-text-primary); }
.ctx-tool-item { padding: 4px 0; font-size: var(--font-size-xs); }
.ctx-tool-name { font-family: var(--font-mono); color: var(--color-text-primary); }
.ctx-history-list { max-height: 300px; overflow-y: auto; }
.ctx-history-item { padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; background: var(--color-bg-secondary, #f9f9f9); font-size: var(--font-size-xs); }
.ctx-history-item.role-user { border-left: 2px solid var(--color-active); }
.ctx-history-item.role-assistant { border-left: 2px solid var(--color-success); }
.ctx-history-item.role-system { border-left: 2px solid var(--color-warning); }
.ctx-history-item.react-thought { border-left: 2px dashed var(--color-agent-violet); opacity: 0.75; }
.ctx-history-item.react-observation { border-left: 2px dashed var(--color-agent-blue); opacity: 0.75; }
.ctx-msg-type { font-size: var(--font-size-xs); padding: 1px 5px; border-radius: 3px; background: var(--color-bg-tertiary); color: var(--color-text-secondary); margin-right: 6px; }
.ctx-role { font-weight: 600; text-transform: uppercase; margin-right: 8px; }
.ctx-content-preview { margin-top: 4px; color: var(--color-text-secondary); word-break: break-all; white-space: pre-wrap; }
.ctx-tool-calls { margin-top: 4px; display: flex; flex-direction: column; gap: 3px; }
.ctx-tool-call { display: flex; flex-direction: column; gap: 1px; padding: 2px 4px; background: var(--color-bg-tertiary, #f0f0f0); border-radius: 3px; }
.ctx-tool-name { font-weight: 600; color: var(--color-agent-violet, #7c3aed); font-size: var(--font-size-xs); }
.ctx-tool-args { font-size: var(--font-size-xs); color: var(--color-text-secondary); word-break: break-all; white-space: pre-wrap; }
.ctx-collapsible {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  user-select: none;
}
.ctx-arrow { font-size: var(--font-size-xs); margin-left: 4px; }
.ctx-mem-scope { margin-bottom: 10px; }
.ctx-mem-scope-title { font-size: var(--font-size-xs); font-weight: 600; color: var(--color-text-secondary); margin-bottom: 4px; }
.ctx-mem-content { max-height: 200px; font-size: var(--font-size-xs); }
.ctx-code-block { background: var(--color-bg-tertiary, #f5f5f5); padding: 12px; border-radius: 6px; font-size: var(--font-size-xs); line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; margin: 0; }
</style>
