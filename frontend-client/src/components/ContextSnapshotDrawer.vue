<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <div v-if="visible" class="ctx-drawer-overlay" @click="$emit('close')">
        <div class="ctx-drawer" @click.stop>
          <div class="ctx-drawer-header">
            <h3>上下文快照</h3>
            <button class="ctx-close-btn" @click="$emit('close')">&times;</button>
          </div>

          <div v-if="loading" class="ctx-loading">加载中...</div>
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
                <span class="ctx-token-text">{{ data.token_stats.total_tokens.toLocaleString() }} / {{ data.token_stats.max_tokens.toLocaleString() }}</span>
              </div>
              <div class="ctx-token-detail">
                <span>System Prompt: {{ data.token_stats.system_prompt_tokens.toLocaleString() }}</span>
                <span>对话历史: {{ data.token_stats.history_tokens.toLocaleString() }}</span>
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

            <!-- 对话历史 -->
            <section class="ctx-section">
              <h4>对话历史 ({{ data.conversation_history.length }})</h4>
              <div class="ctx-history-list">
                <div v-for="(msg, i) in data.conversation_history" :key="i"
                  class="ctx-history-item"
                  :class="msgClass(msg)">
                  <span class="ctx-role">{{ msgLabel(msg) }}</span>
                  <span v-if="msg.react_intermediate" class="ctx-msg-type">R{{ msg.round || '' }}</span>
                  <span class="ctx-tokens">{{ msg.tokens }} tokens</span>
                  <div class="ctx-content-preview" :class="{ expanded: isMessageExpanded(msg, i) }">
                    {{ messageDisplayContent(msg, i) }}
                  </div>
                  <div v-if="messageLoadError(msg, i)" class="ctx-inline-error">{{ messageLoadError(msg, i) }}</div>
                  <button
                    v-if="shouldShowMessageToggle(msg)"
                    type="button"
                    class="ctx-expand-btn"
                    :disabled="isMessageLoading(msg, i)"
                    @click="toggleMessageExpanded(msg, i)"
                  >
                    {{ messageToggleLabel(msg, i) }}
                  </button>
                </div>
              </div>
            </section>

            <!-- System Prompt -->
            <section class="ctx-section">
              <h4 class="ctx-collapsible" @click="spExpanded = !spExpanded">
                System Prompt <span class="ctx-arrow">{{ spExpanded ? '▼' : '▶' }}</span>
              </h4>
              <pre v-if="spExpanded" class="ctx-code-block">{{ data.system_prompt }}</pre>
            </section>

          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  visible: Boolean,
  sessionId: String,
});
defineEmits(['close']);

const loading = ref(false);
const error = ref('');
const data = ref(null);
const spExpanded = ref(false);
const expandedMessages = ref({});
const messageContents = ref({});
const loadingMessages = ref({});
const messageErrors = ref({});

const tokenPct = computed(() => {
  if (!data.value?.token_stats?.max_tokens) return 0;
  return Math.min(100, Math.round(data.value.token_stats.total_tokens / data.value.token_stats.max_tokens * 100));
});

function msgLabel(msg) {
  if (!msg.react_intermediate) {
    if (msg.role === 'assistant') return 'Final Answer';
    return msg.role;
  }
  if (msg.msg_type === 'assistant_response') return 'react-thought';
  else if (msg.msg_type === 'observation') return 'react-observation';
  // return msg.msg_type === 'thought' ? 'MasterAgent Thought' : 'SubAgent Result';
}

function msgClass(msg) {
  if (!msg.react_intermediate) return 'role-' + msg.role;
  if (msg.msg_type === 'assistant_response') return 'react-thought';
  else if (msg.msg_type === 'observation') return 'react-observation';
  // return msg.msg_type === 'thought' ? 'react-thought' : 'react-observation';
}

function getMessageKey(msg, index) {
  return msg.seq != null ? `seq-${msg.seq}` : `${msg.role}-${index}`;
}

function isMessageExpanded(msg, index) {
  return !!expandedMessages.value[getMessageKey(msg, index)];
}

function shouldShowMessageToggle(msg) {
  return Boolean(msg?.is_preview_truncated && msg?.can_load_full_content);
}

function isMessageLoading(msg, index) {
  return !!loadingMessages.value[getMessageKey(msg, index)];
}

function messageLoadError(msg, index) {
  return messageErrors.value[getMessageKey(msg, index)] || '';
}

function getLoadedMessageContent(msg, index) {
  return messageContents.value[getMessageKey(msg, index)] || '';
}

function hasLoadedMessageContent(msg, index) {
  return getLoadedMessageContent(msg, index) !== '';
}

function messageToggleLabel(msg, index) {
  if (isMessageExpanded(msg, index)) return '收起全文';
  if (isMessageLoading(msg, index)) return '加载中...';
  return '展开全文';
}

async function fetchMessageContent(msg, index) {
  if (!props.sessionId || msg?.seq == null) {
    throw new Error('缺少消息定位信息');
  }

  const key = getMessageKey(msg, index);
  loadingMessages.value = {
    ...loadingMessages.value,
    [key]: true,
  };
  messageErrors.value = {
    ...messageErrors.value,
    [key]: '',
  };

  try {
    const params = new URLSearchParams({
      session_id: props.sessionId,
      seq: String(msg.seq),
    });
    const res = await fetch(`/api/agent/context-snapshot/message-content?${params.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || json.detail || '加载全文失败');

    messageContents.value = {
      ...messageContents.value,
      [key]: json.data?.content || '',
    };
  } catch (e) {
    messageErrors.value = {
      ...messageErrors.value,
      [key]: e.message || '加载全文失败',
    };
    throw e;
  } finally {
    loadingMessages.value = {
      ...loadingMessages.value,
      [key]: false,
    };
  }
}

async function toggleMessageExpanded(msg, index) {
  const key = getMessageKey(msg, index);
  if (expandedMessages.value[key]) {
    expandedMessages.value = {
      ...expandedMessages.value,
      [key]: false,
    };
    return;
  }

  if (shouldShowMessageToggle(msg) && !hasLoadedMessageContent(msg, index)) {
    try {
      await fetchMessageContent(msg, index);
    } catch (_) {
      return;
    }
  }

  expandedMessages.value = {
    ...expandedMessages.value,
    [key]: true,
  };
}

function messageDisplayContent(msg, index) {
  if (isMessageExpanded(msg, index)) {
    return getLoadedMessageContent(msg, index) || msg.content_preview || '';
  }
  return msg.content_preview || '';
}

async function fetchSnapshot() {
  loading.value = true;
  error.value = '';
  data.value = null;
  expandedMessages.value = {};
  messageContents.value = {};
  loadingMessages.value = {};
  messageErrors.value = {};
  try {
    const url = `/api/agent/context-snapshot${props.sessionId ? '?session_id=' + encodeURIComponent(props.sessionId) : ''}`;
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || json.detail || '请求失败');
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
.ctx-drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: var(--z-modal); display: flex; justify-content: flex-end; }
.ctx-drawer { width: min(520px, 90vw); height: 100%; background: var(--color-bg-primary, #fff); display: flex; flex-direction: column; box-shadow: -2px 0 12px rgba(0,0,0,.15); }
.ctx-drawer-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--color-border, #e4e7ed); }
.ctx-drawer-header h3 { margin: 0; font-size: 15px; }
.ctx-close-btn { background: none; border: none; font-size: 22px; cursor: pointer; color: var(--color-text-secondary, #666); line-height: 1; }
.ctx-drawer-body { flex: 1; overflow-y: auto; padding: 14px 18px; }
.ctx-loading, .ctx-error { padding: 40px; text-align: center; color: var(--color-text-muted, #999); }
.ctx-error { color: var(--color-error); }
.ctx-section { margin-bottom: 18px; }
.ctx-section h4 { font-size: 13px; margin: 0 0 8px; color: var(--color-text-secondary, #666); }
.ctx-token-bar-wrap { display: flex; align-items: center; gap: 10px; }
.ctx-token-bar { flex: 1; height: 8px; background: var(--color-bg-tertiary, #f0f0f0); border-radius: 4px; overflow: hidden; }
.ctx-token-fill { height: 100%; background: var(--color-success); border-radius: 4px; transition: width .3s; }
.ctx-token-fill.warning { background: var(--color-warning); }
.ctx-token-fill.danger { background: var(--color-error); }
.ctx-token-text { font-size: 12px; white-space: nowrap; color: var(--color-text-secondary, #666); }
.ctx-token-detail { display: flex; gap: 16px; margin-top: 6px; font-size: 12px; color: var(--color-text-muted, #999); }
.ctx-kv-list { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.ctx-kv { font-size: 12px; }
.ctx-kv-group { width: 100%; }
.ctx-kv-nested { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 2px; padding-left: 12px; }
.ctx-kv-sub { font-size: 12px; }
.ctx-k { color: var(--color-text-muted, #999); margin-right: 4px; }
.ctx-k::after { content: ':'; }
.ctx-v { color: var(--color-text-primary, #333); }
.ctx-tool-item { padding: 4px 0; font-size: 12px; }
.ctx-tool-name { font-family: monospace; color: var(--color-text-primary, #333); }
.ctx-history-list { max-height: 300px; overflow-y: auto; }
.ctx-history-item { padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; background: var(--color-bg-secondary, #f9f9f9); font-size: 12px; }
.ctx-history-item.role-user { border-left: 3px solid var(--color-active); }
.ctx-history-item.role-assistant { border-left: 3px solid var(--color-success); }
.ctx-history-item.role-system { border-left: 3px solid var(--color-warning); }
.ctx-history-item.react-thought { border-left: 3px dashed var(--color-agent-master); opacity: 0.75; }
.ctx-history-item.react-observation { border-left: 3px dashed var(--color-agent-qa); opacity: 0.75; }
.ctx-msg-type { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--color-bg-tertiary); color: var(--color-text-secondary); margin-right: 6px; }
.ctx-role { font-weight: 600; text-transform: uppercase; margin-right: 8px; }
.ctx-tokens { color: var(--color-text-muted, #999); float: right; }
.ctx-content-preview { margin-top: 4px; color: var(--color-text-secondary, #666); word-break: break-all; white-space: pre-wrap; }
.ctx-content-preview.expanded { color: var(--color-text-primary, #333); }
.ctx-inline-error { margin-top: 6px; color: var(--color-error); font-size: 12px; }
.ctx-expand-btn { margin-top: 6px; padding: 0; border: none; background: transparent; color: var(--color-active, #409eff); cursor: pointer; font-size: 12px; }
.ctx-expand-btn:hover { text-decoration: underline; }
.ctx-expand-btn:disabled { opacity: 0.65; cursor: wait; text-decoration: none; }
.ctx-collapsible { cursor: pointer; user-select: none; }
.ctx-arrow { font-size: 11px; margin-left: 4px; }
.ctx-code-block { background: var(--color-bg-tertiary, #f5f5f5); padding: 12px; border-radius: 6px; font-size: 12px; line-height: 1.5; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; margin: 0; }
.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity .25s; }
.drawer-fade-enter-active .ctx-drawer, .drawer-fade-leave-active .ctx-drawer { transition: transform .25s; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }
.drawer-fade-enter-from .ctx-drawer { transform: translateX(100%); }
.drawer-fade-leave-to .ctx-drawer { transform: translateX(100%); }
</style>
