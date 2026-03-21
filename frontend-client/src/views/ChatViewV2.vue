<template>
  <div class="chat-view">
    <!-- 遮罩层（移动端） -->
    <div class="sidebar-backdrop" :class="{ 'active': mobileOpen }" @click="closeMobileSidebar"></div>

    <!-- Sidebar -->
    <aside ref="sidebarRef" class="sidebar" :class="{
      'collapsed': sidebarCollapsed,
      'mobile-open': mobileOpen
    }" @touchstart="handleTouchStart" @touchmove="handleTouchMove" @touchend="handleTouchEnd">
      <!-- 系统 Logo 和折叠按钮 -->
      <div class="sidebar-top-bar">
        <div class="sidebar-logo-wrapper" @click="toggleSidebar">
          <!-- 系统 Logo -->
          <IconLogo :size="32" class="sidebar-logo-icon" simple />

          <!-- 展开图标（仅在折叠状态 hover 时显示） -->
          <IconChevronRight :size="20" class="sidebar-expand-icon" />
        </div>

        <!-- 折叠按钮 -->
        <button class="toggle-sidebar-btn" @click="toggleSidebar" :title="'Collapse sidebar'">
          <IconChevronLeft :size="20" />
        </button>
      </div>

      <div class="sidebar-header">
        <button class="sidebar-btn" @click="startNewChat">
          <IconNewConversation :size="22" class="icon" />
          <span class="btn-text">新聊天</span>
        </button>
        <button class="sidebar-btn sidebar-btn-monitor" @click="goToMonitor" title="智能体性能监控">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          <span class="btn-text">监控面板</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToAgentConfig" title="智能体配置">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"></path>
          </svg>
          <span class="btn-text">Agent配置</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToMCPManager" title="MCP 服务管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <path d="M12 22v-5"></path>
            <path d="M9 8V2"></path>
            <path d="M15 8V2"></path>
            <path d="M18 8H6a2 2 0 0 0-2 2v3a7 7 0 0 0 14 0v-3a2 2 0 0 0-2-2z"></path>
          </svg>
          <span class="btn-text">MCP管理</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToVectorLibrary" title="知识库管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
          </svg>
          <span class="btn-text">知识库</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToModelProviders" title="模型 Provider 管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
            <path d="M4.93 4.93a10 10 0 0 0 0 14.14"></path>
          </svg>
          <span class="btn-text">模型管理</span>
        </button>
      </div>

      <div class="history-list" ref="historyListRef" @scroll="handleHistoryScroll">
        <div class="history-label">Recent</div>
        <div v-if="historyLoading" class="history-skeleton">
          <div v-for="n in 6" :key="`history-skeleton-${n}`" class="history-item skeleton-item">
            <div class="skeleton-icon"></div>
            <div class="skeleton-line"></div>
          </div>
        </div>
        <div v-else>
          <div v-for="item in history" :key="item.session_id" class="history-item"
            :class="{ active: item.session_id === currentSessionId }" @click="selectSession(item)">
            <IconDocument :size="18" class="history-icon" />
            <div class="history-main">
              <div class="history-title-row">
                <span class="history-title">{{ item.title || formatTitle(item) || 'New Conversation' }}</span>
                <span class="history-time">{{ formatTimeLabel(item.last_message_at) }}</span>
              </div>
              <div class="history-meta">
                <span v-if="item.unread_count > 0" class="history-unread">{{ item.unread_count }}</span>
              </div>
            </div>
            <button class="history-delete-btn" @click.stop="confirmDeleteSession(item)" title="删除会话">
              <IconTrash :size="16" />
            </button>
          </div>
          <div v-if="historyLoadingMore" class="history-loading-more">加载中...</div>
          <div v-if="historyError" class="history-error">
            <span>{{ historyError }}</span>
            <button class="retry-btn" @click="retryLoadHistory">重试</button>
          </div>
        </div>
      </div>

      <a class="user-profile">
        <div class="avatar">U</div>
        <div class="user-info">
          <div class="username">User</div>
          <div class="user-status">Pro Plan</div>
        </div>
      </a>
    </aside>

    <!-- Main Chat Area -->
    <main class="chat-main" :class="{ 'has-messages': messages.length > 0 }">
      <!-- 顶部控制栏 -->
      <div class="top-controls-bar glass-card" ref="topControlsBarRef">
        <!-- 左侧：汉堡菜单 + LLM 选择器 -->
        <div class="left-controls glass-card">
          <!-- 汉堡菜单按钮（移动端） -->
          <button class="hamburger-menu-btn" @click="openMobileSidebar" :title="'Open menu'">
            <IconMenu :size="20" />
          </button>

          <LLMSelector :model-value="selectedLLM" @update:model-value="emit('update:selectedLLM', $event)" />
        </div>

        <!-- 右侧：主题切换 -->
        <div class="right-controls glass-card">
          <button
            @click="exportCurrentSession"
            class="session-export-btn version-btn"
            :disabled="!currentSessionId || isExportingSession"
            :title="currentSessionId ? '导出当前会话' : '当前无会话可导出'"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12"></path>
              <path d="m7 10 5 5 5-5"></path>
              <path d="M5 21h14"></path>
            </svg>
            <span class="version-label">{{ isExportingSession ? '导出中...' : '导出会话' }}</span>
          </button>
          <button @click="emit('toggleTheme')" class="theme-btn btn" :title="isDark ? '切换到亮色模式' : '切换到暗色模式'">
            <!-- Sun icon for dark mode -->
            <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="5"></circle>
              <line x1="12" y1="1" x2="12" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="23"></line>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
              <line x1="1" y1="12" x2="3" y2="12"></line>
              <line x1="21" y1="12" x2="23" y2="12"></line>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
            <!-- Moon icon for light mode -->
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="chat-messages-wrapper" ref="messagesRef" @scroll="handleScroll">
        <div class="chat-messages">
          <!-- Welcome Screen -->
          <div v-if="messagesLoading" class="messages-skeleton">
            <div v-for="n in 6" :key="`msg-skeleton-${n}`" class="message-skeleton-row"></div>
          </div>
          <div v-else-if="messages.length === 0" class="welcome-screen">
            <div class="welcome-content">
              <div class="welcome-header">
                <div class="logo-placeholder">
                  <!-- 系统 Logo -->
                  <IconLogo :size="80" animated />
                </div>
                <h1>RAG Agent System</h1>
                <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
              </div>
            </div>
          </div>


          <!-- Message Stream -->
          <div v-else class="message-stream">
            <div v-for="(msg, index) in visibleMessages" :key="messageKey(msg)" :class="['message', msg.role]" :data-msg-index="index"
              @mouseenter="messageActionsVisible = index" @mouseleave="messageActionsVisible = null">
              <!-- 持久化压缩：历史摘要占位，详情默认折叠 -->
              <div v-if="msg.role === 'system' && msg.metadata && msg.metadata.compression" class="message-content-wrapper compression-summary">
                <div class="compression-summary-label" @click="expandedSummarySeq = (expandedSummarySeq === msg.seq ? null : msg.seq)">
                  <span class="compression-summary-title">历史摘要</span>
                  <span class="compression-summary-toggle">{{ expandedSummarySeq === msg.seq ? '收起' : '展开' }}</span>
                </div>
                <div v-show="expandedSummarySeq === msg.seq" class="compression-summary-detail markdown-body" v-html="renderMarkdown(msg.content || '')"></div>
              </div>
              <!-- Subtasks Container - 占满整个 message 宽度 -->
              <div v-else-if="msg.role === 'assistant' && ((msg.subtasks && msg.subtasks.length > 0) || (msg.execution_steps && msg.execution_steps.length > 0))"
                class="subtasks-container-full">
                <!-- 常驻 Ticker (现在同时作为 Header) -->
                <SubtaskStatusTicker :subtasks="msg.subtasks" :execution-steps="msg.execution_steps" :expanded="msg.showFullSubtasks"
                  :running="!msg.finished"
                  @toggle-view="msg.showFullSubtasks = !msg.showFullSubtasks" />

                <!-- 视图切换按钮 -->
                <!-- 完整详情模式 -->
                <transition name="expand">
                  <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
                    <!-- 层次化视图 -->
                    <HierarchicalExecutionTree
                      :execution-steps="msg.execution_steps || []"
                      :subtasks="msg.subtasks || []"
                      :react-trace="msg.react_trace || []"
                      :session-id="currentSessionId || ''"
                    />
                  </div>
                </transition>

              </div>

              <div v-if="!(msg.role === 'system' && msg.metadata && msg.metadata.compression)" class="message-content-wrapper">
                <div class="message-content">
                  <!-- Loading State -->
                  <div
                    v-if="msg.role === 'assistant' && !msg.content && (!msg.subtasks || msg.subtasks.length === 0) && !msg.finished"
                    class="loading-indicator">
                    <div class="dot"></div>
                    <div class="dot"></div>
                    <div class="dot"></div>
                  </div>


                  <!-- Multimodal Content + Final Answer（统一内联渲染） -->
                  <template v-if="msg.role === 'assistant'">
                    <template v-for="(part, pi) in parseMessageParts(msg)" :key="pi">
                      <div v-if="part.type === 'text' && part.content?.trim()"
                           class="final-answer">
                        <div class="markdown-body" v-html="renderMarkdown(part.content)"></div>
                      </div>
                      <div v-else-if="part.type === 'viz'" class="inline-chart-wrapper">
                        <VisualizationLoader :artifactId="part.artifactId" @enter-situation="handleEnterSituation" />
                      </div>
                      <div v-else-if="part.type === 'chart'" class="inline-chart-wrapper">
                        <component
                          :is="getChartComponent(msg.multimodalContents[part.index])"
                          v-bind="getChartProps(msg.multimodalContents[part.index])"
                        />
                      </div>
                    </template>
                    <!-- 停止生成标记 -->
                    <div v-if="msg.stopped" class="stopped-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
                      <span>已停止生成</span>
                    </div>
                  </template>

                  <!-- User Message -->
                  <div
                    v-if="msg.role === 'user'"
                    class="user-text"
                    :class="{ 'is-editing': editingMessage === msg }"
                    :contenteditable="editingMessage === msg ? 'plaintext-only' : 'false'"
                    :data-msg-id="msg.id"
                    @keydown.ctrl.enter.prevent="confirmEditAndResend"
                    @keydown.meta.enter.prevent="confirmEditAndResend"
                    @keydown.esc="cancelEdit"
                    @input="e => { if (editingMessage === msg) editingDraft = e.currentTarget.innerText }"
                  >{{ msg.content }}</div>

                  <!-- Status Updates -->
                  <div v-if="msg.status && msg.status.length > 0" class="status-updates">
                    <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-tag" :class="status.type">
                      <span v-if="status.type === 'error'" class="status-icon">⚠️</span>
                      {{ status.content }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- 消息操作 -->
              <div class="message-actions" :class="{ 'visible': messageActionsVisible === index || editingMessage === msg }">
                <template v-if="msg.role === 'user'">
                  <template v-if="editingMessage === msg">
                    <button type="button" class="btn-editor btn-save" @click="confirmEditAndResend">确定</button>
                    <button type="button" class="btn-editor btn-cancel" @click="cancelEdit">取消</button>
                  </template>
                  <template v-else>
                    <button type="button" class="msg-action-btn btn-edit" :disabled="isLoading" title="编辑后确定将替换该条并重新生成回复" @click="startEditMessage(msg)">
                      编辑
                    </button>
                    <button type="button" class="msg-action-btn btn-copy" title="复制内容" @click="copyMessage(msg)">
                      复制
                    </button>
                  </template>
                </template>
                <template v-if="msg.role === 'assistant' && msg.finished">
                  <button type="button" class="msg-action-btn btn-copy" title="复制内容" @click="copyMessage(msg)">
                    复制
                  </button>
                  <button
                    v-if="visibleMessages.slice(0, index).findLast(m => m.role === 'user' && m.seq != null) != null"
                    type="button"
                    class="msg-action-btn btn-retry"
                    :disabled="isLoading"
                    title="删除此条之后的对话并用原问题重新执行（流式输出）"
                    @click="rollbackAndRetry(visibleMessages.slice(0, index).findLast(m => m.role === 'user' && m.seq != null))"
                  >
                    重试
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>
        <!-- <div class="input-area-wrapper" :class="{ 'centered': messages.length === 0 }"> -->
        <transition name="scroll-btn-fade">
          <button v-if="(!isUserAtBottom || !shouldAutoScroll) && messages.length > 0" class="scroll-to-bottom-btn" @click="onScrollToBottomClick" title="滚动到底部">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </transition>
        <div class="input-area-wrapper">
          <div v-if="contextUsage && contextUsage.max > 0 || (currentSessionId && (sessionTaskInfo || isLoading))" class="context-usage-bar">
            <div v-if="contextUsage && contextUsage.max > 0" class="context-usage-content" @click="ctxDrawerVisible = true" title="点击查看上下文详情">
              <svg width="22" height="22" viewBox="0 0 22 22" class="ctx-ring-master" :title="`上下文: ${contextUsage.used.toLocaleString()} / ${contextUsage.max.toLocaleString()} tokens`">
                <circle cx="11" cy="11" r="9" fill="none" :stroke="'var(--ctx-ring-track)'" stroke-width="2.5" />
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  fill="none"
                  :stroke="contextUsageClass === 'danger' ? 'var(--ctx-ring-danger)' : contextUsageClass === 'warning' ? 'var(--ctx-ring-warning)' : 'var(--ctx-ring-success)'"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  :stroke-dasharray="`${contextUsagePct * 0.5655} 56.55`"
                  stroke-dashoffset="0"
                  :style="{ transform: 'rotate(90deg) scaleX(-1)', transformOrigin: '50% 50%' }"
                />
              </svg>
              <span class="context-usage-label">{{ contextUsage.used.toLocaleString() }} / {{ contextUsage.max.toLocaleString() }} tokens</span>
              <span v-if="isCompressing" class="compressing-indicator">
                <span class="compressing-dot"></span>
                压缩中
              </span>
            </div>

            <button
              v-if="showExecutionPill"
              type="button"
              class="execution-pill"
              :class="executionStatusClass"
              :title="executionStatusTooltip"
              @click="openExecutionDrawer"
            >
              <span class="execution-pill-dot"></span>
              <span class="execution-pill-text">{{ executionStatusText }}</span>
              <span class="execution-pill-kind">{{ executionKindLabel }}</span>
            </button>
          </div>
          <ChatInput ref="chatInputRef" v-model="inputMessage" :isLoading="isLoading" @send="handleSend" @stop="handleStop" />
        </div>
      </div>



    </main>
    <AppToast ref="toastRef" />

    <!-- 上下文快照抽屉 -->
    <ContextSnapshotDrawer
      :visible="ctxDrawerVisible"
      :session-id="currentSessionId"
      @close="ctxDrawerVisible = false"
    />

    <!-- 执行诊断抽屉 -->
    <ExecutionDiagnosticsDrawer
      :visible="execDrawerVisible"
      :loading="execDiagnosticsLoading"
      :error-msg="execDiagnosticsError"
      :task-info="sessionTaskInfo"
      :observability="sessionExecutionObservability"
      :diagnostics="sessionExecutionDiagnostics"
      :session-id="currentSessionId"
      :is-executing="isLoading"
      @close="closeExecutionDrawer"
    />

    <!-- 确认对话框 -->
    <ConfirmDialog
      ref="confirmDialogRef"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-text="confirmDialog.confirmText"
      :cancel-text="confirmDialog.cancelText"
      @confirm="confirmDialog.onConfirm"
      @cancel="confirmDialog.onCancel"
    />

    <!-- 工具审批对话框 -->
    <ApprovalDialog ref="approvalDialogRef" />

    <!-- 文件预览确认对话框 -->
    <FilePreviewConfirmDialog ref="filePreviewDialogRef" />

    <!-- 用户输入对话框 -->
    <UserInputDialog ref="userInputDialogRef" />

    <!-- 态势大屏 -->
    <SituationScreen
      v-if="situationScreenActive"
      :artifact-id="situationArtifactId"
      :map-data="situationMapData"
      :messages="messages"
      :is-streaming="isLoading"
      :situation-info="situationInfo"
      @close="situationScreenActive = false"
      @send-message="handleSituationSendMessage"
    />
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { renderMarkdown } from '../utils/markdown';
import SubtaskStatusTicker from '../components/SubtaskStatusTicker.vue';
import HierarchicalExecutionTree from '../components/HierarchicalExecutionTree.vue';
import UserInputDialog from '../components/UserInputDialog.vue';
import ChatInput from '../components/ChatInput.vue';
import MultimodalContent from '../components/MultimodalContent.vue';
import ChartRenderer from '../components/ChartRenderer.vue';
import MapRenderer from '../components/MapRenderer.vue';
import VisualizationLoader from '../components/VisualizationLoader.vue';
import ExecutionDiagnosticsDrawer from '../components/ExecutionDiagnosticsDrawer.vue';
import SituationScreen from '../components/SituationScreen.vue';

// ── 可视化注册表（兼容：仅用于历史消息回放） ─────────────────────────
// 新架构下 SSE 不再推送可视化数据，但历史消息中可能仍有旧格式
const VISUALIZATION_REGISTRY = {
  'visualization.chart': {
    type: 'chart',
    component: ChartRenderer,
    extract: (data) => ({
      type: 'chart',
      echartsConfig: data.echarts_config || data.config,
      title: data.title || 'Data Visualization',
      chartType: data.chart_type || 'bar',
    }),
    props: (item) => ({
      echartsConfig: item.echartsConfig,
      title: item.title,
      chartType: item.chartType,
    }),
  },
  'visualization.map': {
    type: 'map',
    component: MapRenderer,
    extract: (data) => ({
      type: 'map',
      mapData: data.mapData || data.data,
      title: data.title || 'Map Visualization',
    }),
    props: (item) => ({
      mapData: item.mapData,
      title: item.title,
    }),
  },
};

const TYPE_TO_COMPONENT = Object.fromEntries(
  Object.values(VISUALIZATION_REGISTRY).map((r) => [r.type, r.component])
);
const TYPE_TO_PROPS = Object.fromEntries(
  Object.values(VISUALIZATION_REGISTRY).map((r) => [r.type, r.props])
);
import LLMSelector from '../components/LLMSelector.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ApprovalDialog from '../components/ApprovalDialog.vue';
import { useRouter } from 'vue-router';
import FilePreviewConfirmDialog from '../components/FilePreviewConfirmDialog.vue';
import ContextSnapshotDrawer from '../components/ContextSnapshotDrawer.vue';
import AppToast from '../components/AppToast.vue';
import { IconLogo, IconChevronLeft, IconChevronRight, IconDocument, IconPlus, IconNewConversation, IconMenu, IconTrash } from '../components/icons';
import { Icon } from 'leaflet';
import { getTaskExecutionDiagnostics, getTaskStatus } from '../api/monitoring';

// Props
const props = defineProps({
  selectedLLM: {
    type: String,
    default: ''
  },
  isDark: {
    type: Boolean,
    default: true
  }
});

// Emits
const emit = defineEmits(['update:selectedLLM', 'toggleTheme']);

const router = useRouter();

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const topControlsBarRef = ref(null);
const sidebarRef = ref(null);
const historyListRef = ref(null);
const history = ref([]);
const typewriterTimers = ref(new Map());
const isUserAtBottom = ref(true);
const shouldAutoScroll = ref(true);
const sidebarCollapsed = ref(false);
const historyLoading = ref(false);
const historyLoadingMore = ref(false);
const historyError = ref('');
const historyOffset = ref(0);
const historyHasMore = ref(true);
const currentSessionId = ref(null);
const messagesLoading = ref(false);
const chatInputRef = ref(null);
const confirmDialogRef = ref(null);
const approvalDialogRef = ref(null);
const filePreviewDialogRef = ref(null);
const userInputDialogRef = ref(null);
const toastRef = ref(null);
const confirmDialog = ref({
  title: '确认操作',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  onConfirm: () => {},
  onCancel: () => {}
});
const currentStreamController = ref(null);
const activeStreamToken = ref(0);
const isExportingSession = ref(false);
const contextUsage = ref({ used: 0, max: 0 });
const isCompressing = ref(false);
const ctxDrawerVisible = ref(false);
const execDrawerVisible = ref(false);
const execDiagnosticsLoading = ref(false);
const execDiagnosticsError = ref('');
const sessionTaskInfo = ref(null);
const sessionExecutionObservability = ref(null);
const sessionExecutionDiagnostics = ref(null);
const llmRetryState = ref(null);
const retryClockMs = ref(Date.now());
let llmRetryTimer = null;
const messageCache = ref(new Map());
const maxCachedSessions = 10;
const lastFailedSendContent = ref('');

// ── 态势大屏状态 ──────────────────────────────────────────
const situationScreenActive = ref(false);
const situationArtifactId = ref(null);
const situationMapData = ref(null);
const situationInfo = ref(null);
const messageActionsVisible = ref(null);
const editingMessageIndex = ref(null);
const editingDraft = ref('');
/** 展开查看详情的摘要消息 seq（持久化压缩：仅一条生效，用 seq 区分） */
const expandedSummarySeq = ref(null);
const handlePopState = () => {
  const match = window.location.pathname.match(/^\/chat\/([^/]+)$/);
  const sessionId = match ? decodeURIComponent(match[1]) : null;
  if (sessionId && sessionId !== currentSessionId.value) {
    clearExecutionState();
    currentSessionId.value = sessionId;
    loadSessionMessages(sessionId);
  }
  if (!sessionId) {
    invalidateActiveStream();
    clearExecutionState();
    currentSessionId.value = null;
    messages.value = [];
  }
};

const invalidateActiveStream = () => {
  activeStreamToken.value += 1;
  if (currentStreamController.value) {
    currentStreamController.value.abort();
    currentStreamController.value = null;
  }
};

// 移动端状态
const mobileOpen = ref(false);
const isMobile = ref(false);

// 触摸手势状态
const touchStartX = ref(0);
const touchStartY = ref(0);
const touchCurrentX = ref(0);
const isDragging = ref(false);

// 检测是否为移动端
const checkMobile = () => {
  isMobile.value = window.innerWidth < 768;
};

// Sidebar 切换逻辑
const toggleSidebar = () => {
  if (isMobile.value) {
    // 移动端：关闭 sidebar
    closeMobileSidebar();
  } else {
    // 桌面端：折叠/展开
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }
};

// 打开移动端侧边栏
const openMobileSidebar = () => {
  mobileOpen.value = true;
  // 禁止背景滚动
  document.body.style.overflow = 'hidden';
};

// 关闭移动端侧边栏
const closeMobileSidebar = () => {
  mobileOpen.value = false;
  // 恢复背景滚动
  document.body.style.overflow = '';
};

// 触摸手势处理：touchstart
const handleTouchStart = (e) => {
  if (!mobileOpen.value) return;
  touchStartX.value = e.touches[0].clientX;
  touchStartY.value = e.touches[0].clientY;
  isDragging.value = false;
};

// 触摸手势处理：touchmove
const handleTouchMove = (e) => {
  if (!mobileOpen.value) return;
  touchCurrentX.value = e.touches[0].clientX;

  const deltaX = touchCurrentX.value - touchStartX.value;
  const deltaY = Math.abs(e.touches[0].clientY - touchStartY.value);

  // 如果横向滑动距离大于纵向，判断为滑动关闭手势
  if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > deltaY) {
    isDragging.value = true;

    // 向左滑动（关闭）
    if (deltaX < 0 && sidebarRef.value) {
      const translateX = Math.max(deltaX, -280);
      sidebarRef.value.style.transform = `translateX(${translateX}px)`;
      e.preventDefault(); // 阻止页面滚动
    }
  }
};

// 触摸手势处理：touchend
const handleTouchEnd = (e) => {
  if (!mobileOpen.value || !isDragging.value) {
    if (sidebarRef.value) {
      sidebarRef.value.style.transform = '';
    }
    return;
  }

  const deltaX = touchCurrentX.value - touchStartX.value;

  // 滑动距离超过 100px 或速度足够快，则关闭
  if (deltaX < -100 || (deltaX < -30 && Math.abs(deltaX) > 50)) {
    closeMobileSidebar();
  }

  // 重置 transform
  if (sidebarRef.value) {
    sidebarRef.value.style.transform = '';
  }

  isDragging.value = false;
};

const startNewChat = () => {
  invalidateActiveStream();
  clearExecutionState();
  messages.value = [];
  inputMessage.value = '';
  typewriterTimers.value.forEach(timer => clearTimeout(timer));
  typewriterTimers.value.clear();
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;
  currentSessionId.value = null;
  router.replace('/');
  focusInput();
};

const goToMonitor = () => {
  router.push('/monitor');
};

const goToAgentConfig = () => {
  router.push('/agent-config');
};

const goToMCPManager = () => {
  router.push('/mcp');
};

const goToVectorLibrary = () => {
  router.push('/vector-library');
};

const goToModelProviders = () => {
  router.push('/model-providers');
};

const typewriter = (target, key, text, speed = 30, timerId = null) => {
  if (timerId && typewriterTimers.value.has(timerId)) {
    clearTimeout(typewriterTimers.value.get(timerId));
    typewriterTimers.value.delete(timerId);
  }

  let currentIndex = 0;
  const originalText = target[key] || '';

  if (speed === 0) {
    target[key] = originalText + text;
    scrollToBottom();
    return;
  }

  const type = () => {
    if (currentIndex < text.length) {
      const displayText = originalText + text.substring(0, currentIndex + 1);
      target[key] = displayText;
      currentIndex++;
      const timer = setTimeout(type, speed);
      if (timerId) typewriterTimers.value.set(timerId, timer);
      scrollToBottom();
    } else {
      if (timerId) typewriterTimers.value.delete(timerId);
    }
  };
  type();
};

const checkIfAtBottom = () => {
  if (!messagesRef.value) return true;
  const container = messagesRef.value;
  return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
};

const scrollToBottom = async (force = false) => {
  await nextTick();
  if (!messagesRef.value) return;
  if (force || shouldAutoScroll.value) {
    _isProgrammaticScroll = true;
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
};

let _isProgrammaticScroll = false;
let _lastScrollTop = 0;
// 用户主动向上滚动的累计距离，超过阈值才判定为"明显离开底部"
let _userScrollUpAccum = 0;
// 用户需要向上滚动超过此距离才更新底部状态（移动端触摸惯性友好）
const SCROLL_DETACH_THRESHOLD = 200;

const handleScroll = () => {
  const container = messagesRef.value;
  if (!container) return;

  if (_isProgrammaticScroll) {
    // 程序触发的滚动，重置累计，保持在底部
    _isProgrammaticScroll = false;
    _lastScrollTop = container.scrollTop;
    _userScrollUpAccum = 0;
    isUserAtBottom.value = checkIfAtBottom();
    shouldAutoScroll.value = isUserAtBottom.value;
  } else if (isLoading.value) {
    // 流式输出中
    const delta = container.scrollTop - _lastScrollTop;
    _lastScrollTop = container.scrollTop;

    if (delta < 0) {
      // 用户主动向上滚动
      shouldAutoScroll.value = false;
      _userScrollUpAccum += Math.abs(delta);
      if (_userScrollUpAccum >= SCROLL_DETACH_THRESHOLD) {
        isUserAtBottom.value = false;
      }
    } else if (delta > 0) {
      // 用户向下滚动或 DOM 增长推动
      if (checkIfAtBottom()) {
        // 回到底部，重置累计
        _userScrollUpAccum = 0;
        isUserAtBottom.value = true;
        shouldAutoScroll.value = true;
      }
    }
    // delta === 0: DOM 增长导致的被动事件，不改变意图
  } else {
    // 非流式：直接用位置判断
    _lastScrollTop = container.scrollTop;
    _userScrollUpAccum = 0;
    isUserAtBottom.value = checkIfAtBottom();
    shouldAutoScroll.value = isUserAtBottom.value;
  }

  // 控制 top-controls-bar 的边框显示
  if (topControlsBarRef.value) {
    if (container.scrollTop > 0) {
      topControlsBarRef.value.classList.add('scrolled');
    } else {
      topControlsBarRef.value.classList.remove('scrolled');
    }
  }
};

const onScrollToBottomClick = () => {
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;
  scrollToBottom(true);
};

// 🎯 统一的 Agent 信息解析：从事件 / 持久化 payload 中取「被调用 Agent」与展示名
const getCalledAgentAndDisplayName = (eventOrStep) => {
  // eventOrStep 可能是 SSE 里的 event，也可能是持久化的 step
  const payload = eventOrStep && eventOrStep.payload ? eventOrStep.payload : null;
  const eventData = payload ? (payload.data || {}) : (eventOrStep.data || {});
  const publisherAgent = payload ? payload.agent_name : eventOrStep.agent_name;

  // 被调用的 Agent：优先用 data.agent_name，其次退回事件的 agent_name
  const calledAgent = eventData.agent_name != null ? eventData.agent_name : publisherAgent;

  // 展示名：优先用 agent_display_name / subtask_agent，其次退回被调用 Agent 名
  const displayName =
    eventData.agent_display_name ||
    eventData.subtask_agent ||
    calledAgent;

  return { calledAgent, displayName };
};

const ORCHESTRATOR_AGENT_NAMES = new Set(['orchestrator_agent']);

const isOrchestratorAgentName = (agentName) => !agentName || ORCHESTRATOR_AGENT_NAMES.has(agentName);

const isSubtaskStartEvent = (eventType, calledAgent, parentCallId) => {
  if (eventType === 'call.agent.start') return !isOrchestratorAgentName(calledAgent);
  if (eventType === 'agent.start') return !!parentCallId && !isOrchestratorAgentName(calledAgent);
  return false;
};

const isSubtaskEndEvent = (eventType, calledAgent, parentCallId) => {
  if (eventType === 'call.agent.end') return !isOrchestratorAgentName(calledAgent);
  if (eventType === 'agent.end') return !!parentCallId && !isOrchestratorAgentName(calledAgent);
  return false;
};

const getLatestRound = (steps = []) => {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const round = steps[i]?.round;
    if (typeof round === 'number' && Number.isFinite(round)) {
      return round;
    }
  }
  return null;
};

const buildSubtaskState = ({
  eventData = {},
  fallbackRound = null,
  existing = null,
  calledAgent = '',
  displayName = '',
  taskId = null,
  parentCallId = null
} = {}) => ({
  order: eventData.order ?? existing?.order,
  task_id: taskId ?? existing?.task_id ?? null,
  parent_call_id: parentCallId ?? existing?.parent_call_id ?? null,
  round: eventData.round ?? existing?.round ?? fallbackRound,
  round_index: eventData.round_index ?? existing?.round_index,
  agent_name: calledAgent || existing?.agent_name || '',
  agent_display_name: displayName || existing?.agent_display_name || calledAgent || '',
  description: eventData.subtask_description || eventData.description || eventData.task || existing?.description || '',
  react_steps: Array.isArray(existing?.react_steps) ? existing.react_steps : [],
  tool_calls: Array.isArray(existing?.tool_calls) ? existing.tool_calls : [],
  result_summary: typeof existing?.result_summary === 'string' ? existing.result_summary : '',
  status: (existing?.status === 'success' || existing?.status === 'error')
    ? existing.status
    : 'running',
  expanded: true,
  currentStep: Object.prototype.hasOwnProperty.call(existing || {}, 'currentStep') ? existing.currentStep : null
});

const getToolPreviewResult = (toolData = {}) => (
  toolData.result_preview ?? toolData.result ?? ''
);

const hasToolRawResult = (toolData = {}) => (
  Object.prototype.hasOwnProperty.call(toolData, 'raw_result') && toolData.raw_result != null
);

const getToolRawResultAvailable = (toolData = {}) => (
  Boolean(toolData.raw_result_available) || hasToolRawResult(toolData)
);

// 将规范化后的 execution_steps 还原为 subtasks 与 execution_steps
function executionStepsToExecutionState(executionSteps) {
  if (!Array.isArray(executionSteps) || executionSteps.length === 0) return { subtasks: [], execution_steps: [] };

  const callNodes = new Map();
  const toolCalls = new Map();
  const execution_steps = [];

  const ensureOrchestratorStep = (round = null, intent = '', options = {}) => {
    const { markIntentComplete = false } = options;
    let step = execution_steps[execution_steps.length - 1];
    const shouldCreateNewStep = !step
      || (step._intentComplete && (round == null || step.round !== round))
      || (round != null && step.round != null && step.round !== round);
    if (shouldCreateNewStep) {
      step = {
        round,
        intent: intent || '',
        toolCalls: [],
        expanded: true,
        _intentComplete: Boolean(markIntentComplete && intent)
      };
      execution_steps.push(step);
    } else if (intent) {
      step.intent = step.intent ? step.intent : intent;
    }
    if (round != null && step.round == null) step.round = round;
    if (markIntentComplete) step._intentComplete = true;
    return step;
  };

  const getOrchestratorStepForTool = (round = null) => {
    const resolvedRound = round ?? getLatestRound(execution_steps) ?? 1;
    let step = execution_steps[execution_steps.length - 1];

    if (!step) {
      step = { round: resolvedRound, intent: '', toolCalls: [], expanded: true };
      execution_steps.push(step);
      return step;
    }

    if (step.round == null) step.round = resolvedRound;
    if (step.round === resolvedRound) return step;

    for (let i = execution_steps.length - 1; i >= 0; i -= 1) {
      if (execution_steps[i]?.round === resolvedRound) {
        return execution_steps[i];
      }
    }

    step = { round: resolvedRound, intent: '', toolCalls: [], expanded: true };
    execution_steps.push(step);
    return step;
  };

  for (const step of executionSteps) {
    const kind = step.kind;
    const callId = step.call_id;
    const parentCallId = step.parent_call_id;

    if (kind === 'subtask_start') {
      if (isOrchestratorAgentName(step.agent_name)) {
        continue;
      }
      const existing = callNodes.get(callId);
      callNodes.set(callId, buildSubtaskState({
        eventData: step,
        fallbackRound: getLatestRound(execution_steps),
        existing,
        calledAgent: step.agent_name,
        displayName: step.agent_display_name || step.agent_name,
        taskId: callId,
        parentCallId,
      }));
      continue;
    }

    if (kind === 'subtask_end') {
      if (isOrchestratorAgentName(step.agent_name)) {
        continue;
      }
      const node = callNodes.get(callId);
      if (node) {
        node.status = step.status || 'success';
        node.result_summary = step.result_summary || '';
        node.expanded = false;
      }
      continue;
    }

    if (kind === 'agent_intent') {
      ensureOrchestratorStep(step.round, step.content || '', { markIntentComplete: true });
      continue;
    }

    if (kind === 'subtask_intent') {
      const node = callNodes.get(callId);
      if (node) {
        // ⚠️ 【禁止随意修改】历史数据去重保护
        // 旧数据库中同一轮次可能同时存在两条 subtask_intent 记录：
        //   1. agent.intent_complete → runstep_normalizer 转为 subtask_intent（携带完整内容）
        //   2. react.intermediate (role=assistant) → 同样转为 subtask_intent（补发）
        // 新数据已不再依赖这条补发链路，但这里仍需保留同 round 合并逻辑以兼容旧会话。
        // 若直接无条件 push 新 reactStep，同一 round 会出现两个意图块，导致前端显示错位。
        // 正确做法：同一 round 的第二条直接合并（内容为空时才补填），不新建 step。
        const existing = node.currentStep;
        if (existing && existing.round === step.round) {
          if (!existing.intent && step.content) existing.intent = step.content;
        } else {
          const reactStep = {
            round: step.round,
            intent: step.content || '',
            toolCalls: [],
            expanded: true
          };
          node.react_steps.push(reactStep);
          node.currentStep = reactStep;
        }
      }
      continue;
    }

    if (kind === 'tool_start') {
      const toolCall = {
        call_id: callId,
        parent_call_id: parentCallId,
        tool_name: step.tool_name,
        arguments: step.arguments,
        status: 'running',
        result: '',
        result_preview: '',
        raw_result: null,
        raw_result_ref: null,
        raw_result_available: false,
        showResult: false,
        showArgs: false
      };
      toolCalls.set(callId, toolCall);

      const parentNode = callNodes.get(parentCallId);
      if (parentNode) {
        parentNode.tool_calls.push(toolCall);
        if (parentNode.currentStep) {
          parentNode.currentStep.toolCalls.push(toolCall);
        } else {
          const reactStep = { round: parentNode.round, intent: '', toolCalls: [toolCall], expanded: true };
          parentNode.react_steps.push(reactStep);
          parentNode.currentStep = reactStep;
        }
      } else {
        getOrchestratorStepForTool(step.round).toolCalls.push(toolCall);
      }
      continue;
    }

    if (kind === 'tool_end') {
      const toolCall = toolCalls.get(callId);
      if (toolCall) {
        toolCall.status = step.success === false ? 'error' : 'success';
        toolCall.result = getToolPreviewResult(step);
        toolCall.result_preview = getToolPreviewResult(step);
        toolCall.raw_result = hasToolRawResult(step) ? step.raw_result : null;
        toolCall.raw_result_ref = step.raw_result_ref || null;
        toolCall.raw_result_available = getToolRawResultAvailable(step);
        toolCall.elapsed_time = step.elapsed_time;
      }
      continue;
    }
  }

  return {
    subtasks: Array.from(callNodes.values()),
    execution_steps,
  };
}

function extractMultimodalFromExecutionSteps(executionSteps) {
  if (!Array.isArray(executionSteps)) return [];
  const contents = [];
  for (const step of executionSteps) {
    if (step.kind === 'visualization') {
      const eventType = step.visualization_type === 'chart' ? 'visualization.chart' : 'visualization.map';
      const reg = VISUALIZATION_REGISTRY[eventType];
      if (reg) {
        contents.push(reg.extract(step.data || {}));
      }
    }
  }
  return contents;
}

const isMasterEvent = (event) => {
  const agentName = event.agent_name || event.data?.agent_name;
  return isOrchestratorAgentName(agentName);
};

const findSubtaskByCallId = (subtasks, callId) => {
  if (!callId || !Array.isArray(subtasks)) return null;
  return subtasks.find(s => s.task_id === callId) || null;
};

const formatTitle = (item) => {
  const content = (item.first_message || item.last_message || '').trim();
  return content ? content.slice(0, 30) : '';
};

const formatTimeLabel = (timeStr) => {
  if (!timeStr) return '';
  const time = new Date(timeStr);
  if (Number.isNaN(time.getTime())) return '';
  const now = new Date();
  const diffMs = now - time;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  const isYesterday = now.toDateString() !== time.toDateString()
    && new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString() === time.toDateString();
  if (isYesterday) return '昨天';
  const yyyy = time.getFullYear();
  const mm = String(time.getMonth() + 1).padStart(2, '0');
  const dd = String(time.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const showToast = (message, actionOrType = null, actionLabel = '重试') => {
  let type = 'error';
  let action = null;
  if (typeof actionOrType === 'string') {
    type = actionOrType;
  } else if (typeof actionOrType === 'function') {
    action = actionOrType;
  }
  toastRef.value?.show(message, action || type, actionLabel);
};

const getActiveAssistantMessage = () => {
  for (let i = messages.value.length - 1; i >= 0; i -= 1) {
    const msg = messages.value[i];
    if (msg?.role === 'assistant' && !msg.finished) {
      return msg;
    }
  }
  return null;
};

const formatRetryCountdown = (state) => {
  if (!state?.nextRetryAt) return '';
  const remainingMs = Math.max(0, state.nextRetryAt - retryClockMs.value);
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return remainingSeconds > 0 ? `${remainingSeconds} 秒后重试` : '即将重试';
};

const buildLlmRetryStatusText = (state) => {
  if (!state) return '';
  const countdown = formatRetryCountdown(state);
  const errorHint = state.error ? `（${state.error}）` : '';
  return `模型调用失败${errorHint}，准备第 ${state.nextAttempt}/${state.maxAttempts} 次重试${countdown ? `，${countdown}` : ''}`;
};

const syncActiveMessageRetryStatus = () => {
  const currentMsg = getActiveAssistantMessage();
  if (!currentMsg) return;
  if (!Array.isArray(currentMsg.status)) currentMsg.status = [];
  const retryIndex = currentMsg.status.findIndex(item => item.kind === 'llm_retry');
  if (!llmRetryState.value) {
    if (retryIndex >= 0) currentMsg.status.splice(retryIndex, 1);
    return;
  }
  const retryStatus = {
    kind: 'llm_retry',
    type: 'warning',
    content: buildLlmRetryStatusText(llmRetryState.value),
  };
  if (retryIndex >= 0) {
    currentMsg.status.splice(retryIndex, 1, retryStatus);
  } else {
    currentMsg.status.push(retryStatus);
  }
};

const stopRetryTicker = () => {
  if (llmRetryTimer != null) {
    clearInterval(llmRetryTimer);
    llmRetryTimer = null;
  }
};

const ensureRetryTicker = () => {
  if (llmRetryTimer != null) return;
  llmRetryTimer = window.setInterval(() => {
    retryClockMs.value = Date.now();
    if (!llmRetryState.value) {
      stopRetryTicker();
      return;
    }
    syncActiveMessageRetryStatus();
  }, 250);
};

const setLlmRetryState = (retryData) => {
  llmRetryState.value = retryData ? {
    ...retryData,
    nextRetryAt: Date.now() + Math.max(0, retryData.waitMs || 0),
  } : null;
  retryClockMs.value = Date.now();
  if (llmRetryState.value) {
    ensureRetryTicker();
  } else {
    stopRetryTicker();
  }
  syncActiveMessageRetryStatus();
};

const clearLlmRetryState = () => {
  if (!llmRetryState.value) return;
  llmRetryState.value = null;
  retryClockMs.value = Date.now();
  syncActiveMessageRetryStatus();
  stopRetryTicker();
};

const focusInput = async () => {
  if (chatInputRef.value?.focus) {
    await chatInputRef.value.focus();
  }
};

const handleHistoryScroll = () => {
  if (!historyListRef.value || historyLoadingMore.value || !historyHasMore.value) return;
  const el = historyListRef.value;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    loadRecentSessions(false);
  }
};

const loadRecentSessions = async (reset = false) => {
  if (historyLoading.value || historyLoadingMore.value) return;
  if (!historyHasMore.value && !reset) return;
  if (reset) {
    historyOffset.value = 0;
    historyHasMore.value = true;
  }
  if (reset) {
    historyLoading.value = true;
  } else {
    historyLoadingMore.value = true;
  }
  historyError.value = '';
  try {
    const userId = (localStorage.getItem('userId') || '').trim();
    const params = new URLSearchParams({
      limit: String(20),
      offset: String(historyOffset.value)
    });
    if (userId) {
      params.set('user_id', userId);
    }
    const response = await fetch(`/api/agent/sessions?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const payload = result.data || {};
    const items = payload.items || [];
    if (reset) {
      history.value = items;
    } else {
      history.value = history.value.concat(items);
    }
    historyOffset.value += items.length;
    historyHasMore.value = payload.has_more ?? items.length >= 20;
  } catch (error) {
    historyError.value = '加载失败，请重试';
    showToast('加载历史列表失败', retryLoadHistory);
  } finally {
    historyLoading.value = false;
    historyLoadingMore.value = false;
  }
};

const retryLoadHistory = () => {
  loadRecentSessions(true);
};

const exportCurrentSession = async () => {
  const sessionId = currentSessionId.value;
  if (!sessionId) {
    showToast('当前无会话');
    return;
  }
  if (isExportingSession.value) return;

  isExportingSession.value = true;
  try {
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/export`);
    if (!response.ok) {
      let errorMessage = '导出会话失败';
      try {
        const result = await response.json();
        errorMessage = result.detail || result.message || errorMessage;
      } catch (_) {}
      throw new Error(errorMessage);
    }

    const blob = await response.blob();
    const contentDisposition = response.headers.get('content-disposition') || '';
    const match = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
    const filename = match
      ? decodeURIComponent(match[1].replace(/"/g, '').trim())
      : `session_${sessionId}.json`;

    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);

    showToast('会话导出成功', 'success');
  } catch (error) {
    showToast(error.message || '导出会话失败');
  } finally {
    isExportingSession.value = false;
  }
};

const cacheMessages = (sessionId, list) => {
  if (!sessionId) return;
  if (messageCache.value.has(sessionId)) {
    messageCache.value.delete(sessionId);
  }
  messageCache.value.set(sessionId, list.slice(-500));
  if (messageCache.value.size > maxCachedSessions) {
    const oldestKey = messageCache.value.keys().next().value;
    messageCache.value.delete(oldestKey);
  }
};

/** 仅从服务端拉取并合并 id/seq 到当前列表（不替换整表，避免闪烁）
 *  注意：流结束后 subtasks/execution_steps 已由 SSE 事件填充完毕，
 *  此处仅补全 id/seq，不重写任何 UI 相关字段，避免引起重渲染闪烁。
 */
const mergeMessageIdsFromServer = async (sessionId) => {
  if (!sessionId || messages.value.length === 0) return;
  try {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0`);
    if (!res.ok) return;
    const result = await res.json();
    const items = result.data?.items || [];
    if (items.length !== messages.value.length) return;
    for (let i = 0; i < items.length; i++) {
      const m = messages.value[i];
      const it = items[i];
      if (!m || !it) continue;
      if (m.role !== it.role) continue;
      // 只补全持久化 ID，不触碰任何 UI 渲染相关字段
      m.id = it.id;
      m.seq = it.seq;
    }
    cacheMessages(sessionId, messages.value);
  } catch (_) {}
};

/** 加载指定会话的上下文用量快照（用于历史会话进入时恢复上下文指示器） */
const loadContextSnapshot = async (sessionId) => {
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/agent/context-snapshot?session_id=${encodeURIComponent(sessionId)}`);
    if (!res.ok) return;
    const json = await res.json();
    const tokenStats = json.data?.token_stats;
    console.log('Loaded context snapshot for session', sessionId, tokenStats);
    if (
      tokenStats &&
      typeof tokenStats.total_tokens === 'number' &&
      typeof tokenStats.budget_tokens === 'number'
    ) {
      contextUsage.value = {
        used: tokenStats.total_tokens,
        max: tokenStats.budget_tokens
      };
    }
  } catch (_) {
    // 静默失败，不影响主流程
  }
};

const buildObservabilityFromTaskInfo = (taskInfo) => {
  if (!taskInfo) return null;
  return {
    task_id: taskInfo.task_id,
    session_id: taskInfo.session_id,
    run_id: taskInfo.run_id,
    execution_kind: taskInfo.execution_kind,
    request_id: taskInfo.request_id,
  };
};

const mergeExecutionObservability = (payload = {}) => {
  const current = sessionExecutionObservability.value || {};
  sessionExecutionObservability.value = {
    task_id: payload.task_id ?? current.task_id ?? null,
    session_id: payload.session_id ?? current.session_id ?? currentSessionId.value ?? null,
    run_id: payload.run_id ?? current.run_id ?? null,
    execution_kind: payload.execution_kind ?? current.execution_kind ?? null,
    request_id: payload.request_id ?? current.request_id ?? null,
  };
};

const refreshSessionExecutionDiagnostics = async (sessionId, { silent = true } = {}) => {
  if (!sessionId) return null;
  if (!silent) {
    execDiagnosticsLoading.value = true;
    execDiagnosticsError.value = '';
  }
  try {
    const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/execution-diagnostics`);
    if (!resp.ok) return null;
    const result = await resp.json();
    const diagnostics = result.data?.diagnostics || null;
    // 请求返回时 session 已切换，丢弃过期结果
    if (currentSessionId.value !== sessionId) return null;
    sessionExecutionDiagnostics.value = diagnostics;
    if (diagnostics?.observability) {
      mergeExecutionObservability(diagnostics.observability);
    }
    return diagnostics;
  } catch (error) {
    if (!silent) {
      execDiagnosticsError.value = error.message || '加载执行诊断失败';
    }
    return null;
  } finally {
    if (!silent) execDiagnosticsLoading.value = false;
  }
};

const refreshSessionExecutionState = async (sessionId, { silent = true } = {}) => {
  if (!sessionId) return;
  try {
    const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
    if (resp.ok) {
      const result = await resp.json();
      // 请求返回时 session 已切换，丢弃过期结果
      if (currentSessionId.value !== sessionId) return;
      if (result.data?.task_info) {
        sessionTaskInfo.value = result.data.task_info;
      }
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
    }
  } catch (_) {
    if (!silent) {
      execDiagnosticsError.value = '同步执行状态失败';
    }
  }
  await refreshSessionExecutionDiagnostics(sessionId, { silent });
};

const clearExecutionState = () => {
  clearLlmRetryState();
  sessionTaskInfo.value = null;
  sessionExecutionObservability.value = null;
  sessionExecutionDiagnostics.value = null;
  execDiagnosticsError.value = '';
  execDrawerVisible.value = false;
};

const beginOptimisticExecutionState = (sessionId) => {
  sessionTaskInfo.value = {
    ...(sessionTaskInfo.value || {}),
    task_id: null,
    session_id: sessionId,
    run_id: null,
    execution_kind: 'agent_stream',
    request_id: null,
    elapsed_seconds: null,
    started_at: null,
    finished_at: null,
    thread_alive: true,
    status: 'running',
  };
  sessionExecutionDiagnostics.value = null;
  execDiagnosticsError.value = '';
  mergeExecutionObservability({
    task_id: null,
    session_id: sessionId,
    run_id: null,
    execution_kind: 'agent_stream',
    request_id: null,
  });
};

/** 检查会话是否有正在执行的任务，若有则恢复 loading 状态并重连 SSE */
const checkSessionTaskStatus = async (sessionId) => {
  if (!sessionId) return;
  try {
    const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
    if (!resp.ok) return;
    const result = await resp.json();
    if (result.data?.task_info) {
      sessionTaskInfo.value = result.data.task_info;
    }
    if (result.data?.observability) {
      mergeExecutionObservability(result.data.observability);
    } else if (result.data?.task_info) {
      mergeExecutionObservability(buildObservabilityFromTaskInfo(result.data.task_info));
    }
    if (result.data?.has_running_task) {
      isLoading.value = true;
      showToast('正在恢复执行中的任务...', 'warning');
      // 创建一个占位 assistant 消息（如果最后一条不是未完成的 assistant）
      const lastMsg = messages.value[messages.value.length - 1];
      if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.finished) {
        messages.value.push({
          role: 'assistant',
          content: '',
          subtasks: [],
          execution_steps: [],
          showFullSubtasks: false,
          multimodalContents: [],
          status: [],
          toolCallRegistry: new Map(),
          finished: false
        });
      }
      // 重连 SSE（不 await，避免阻塞 loadSessionMessages 的 finally 导致 messagesLoading 一直为 true）
      reconnectToRunningTask(sessionId);
    } else if (!isLoading.value) {
      await refreshSessionExecutionDiagnostics(sessionId, { silent: true });
    }
  } catch (e) {
    // 查询失败不影响主流程
  }
};

/** 重连到正在执行的任务，恢复 SSE 事件流 */
const reconnectToRunningTask = async (sessionId) => {
  const controller = new AbortController();
  const streamToken = activeStreamToken.value + 1;
  activeStreamToken.value = streamToken;
  currentStreamController.value = controller;

  const assistantMsgIndex = messages.value.length - 1;

  try {
    const response = await fetch('/api/agent/stream/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ session_id: sessionId })
    });
    if (!response.ok) {
      // 任务已结束（404）或其他错误：清理占位消息
      _cleanupReconnectPlaceholder(assistantMsgIndex, sessionId);
      isLoading.value = false;
      return;
    }

    // 复用与 handleSend 相同的 SSE 读取+事件分发逻辑
    await processSSEStream(response, assistantMsgIndex, sessionId, streamToken);
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('重连失败:', e);
  } finally {
    isLoading.value = false;
    if (activeStreamToken.value === streamToken) {
      currentStreamController.value = null;
    }
    await refreshSessionExecutionDiagnostics(sessionId, { silent: true });
    scrollToBottom();
  }
};

/** 重连失败时清理空的占位 assistant 消息 */
const _cleanupReconnectPlaceholder = (msgIndex, sessionId) => {
  const msg = messages.value[msgIndex];
  if (msg && msg.role === 'assistant' && !msg.content && !msg.finished) {
    messages.value.splice(msgIndex, 1);
    cacheMessages(sessionId, messages.value);
  }
};

const loadSessionMessages = async (sessionId) => {
  if (!sessionId) return;
  invalidateActiveStream();
  messagesLoading.value = true;
  historyError.value = '';
  try {
    const cached = messageCache.value.get(sessionId);
    if (cached) {
      messages.value = cached;
      messagesLoading.value = false;
      await nextTick();
      await scrollToBottom(true);
      focusInput();
      await loadContextSnapshot(sessionId);
      // 缓存命中也需检查是否有运行中任务
      await checkSessionTaskStatus(sessionId);
      return;
    }
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const items = result.data?.items || [];
    const mapped = items.map(item => {
      if (item.role === 'assistant') {
        const executionSteps = item.execution_steps || [];
        const parsed = Array.isArray(executionSteps) ? executionStepsToExecutionState(executionSteps) : { subtasks: [], execution_steps: [] };
        const subtasks = parsed.subtasks || [];
        return {
          role: 'assistant',
          id: item.id,
          seq: item.seq,
          content: item.content || '',
          subtasks,
          execution_steps: parsed.execution_steps || [],
          react_trace: item.react_trace || [],
          showFullSubtasks: false,
          multimodalContents: (item.multimodalContents?.length > 0)
            ? item.multimodalContents
            : extractMultimodalFromExecutionSteps(executionSteps),
          status: item.status || [],
          finished: true
        };
      }
      if (item.role === 'system') {
        return {
          role: 'system',
          id: item.id,
          seq: item.seq,
          content: item.content || '',
          metadata: item.metadata || {}
        };
      }
      return { role: 'user', id: item.id, seq: item.seq, content: item.content || '', metadata: item.metadata || {} };
    });
    messages.value = mapped;
    expandedSummarySeq.value = null;
    cacheMessages(sessionId, mapped);
    messagesLoading.value = false;
    await nextTick();
    await scrollToBottom(true);
    focusInput();
    await loadContextSnapshot(sessionId);
    // ── 检查该会话是否有正在执行的任务 ──
    await checkSessionTaskStatus(sessionId);
  } catch (error) {
    showToast('加载会话失败', () => loadSessionMessages(sessionId));
  } finally {
    messagesLoading.value = false;
  }
};

const selectSession = async (item) => {
  if (!item?.session_id) return;
  if (currentSessionId.value === item.session_id && messages.value.length > 0) return;
  currentSessionId.value = item.session_id;
  window.history.pushState({}, '', `/chat/${encodeURIComponent(item.session_id)}`);
  item.unread_count = 0;
  closeMobileSidebar();
  await loadSessionMessages(item.session_id);
};

const updateRecentSession = (sessionId, content, timestamp) => {
  if (!sessionId) return;
  const time = timestamp || new Date().toISOString();
  const idx = history.value.findIndex(h => h.session_id === sessionId);
  if (idx >= 0) {
    const item = history.value[idx];
    item.last_message = content;
    item.last_message_at = time;
    if (!item.title) {
      item.title = (item.title || content || '').toString().slice(0, 30);
    }
    history.value.splice(idx, 1);
    history.value.unshift(item);
  } else {
    history.value.unshift({
      session_id: sessionId,
      title: content ? content.slice(0, 30) : '',
      last_message: content,
      last_message_at: time,
      unread_count: 0
    });
  }
};

let _msgKeyCounter = 0;
const messageKey = (msg) => {
  if (msg._key == null) msg._key = `mk-${_msgKeyCounter++}`;
  return msg._key;
};

/** 用于展示的消息列表：按 seq 升序，若有 compression 则隐藏 seq < 最后一条摘要.seq 的消息 */
const visibleMessages = computed(() => {
  const list = messages.value;
  if (!list.length) return [];
  const withSeq = list.filter(m => m.seq != null);
  const summaryMsg = withSeq.filter(m => (m.metadata && m.metadata.compression) === true).sort((a, b) => (b.seq - a.seq))[0];
  const summarySeq = summaryMsg ? summaryMsg.seq : null;
  if (summarySeq == null) return list;
  return list.filter(m => m.seq == null || m.seq >= summarySeq);
});

const editingMessage = computed(() => {
  const i = editingMessageIndex.value;
  if (i == null || i < 0) return null;
  return messages.value[i] || null;
});

const contextUsagePct = computed(() => {
  if (!contextUsage.value?.max) return 0;
  return Math.min(100, Math.round(contextUsage.value.used / contextUsage.value.max * 100));
});

const contextUsageClass = computed(() => {
  const pct = contextUsagePct.value;
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warning';
  return '';
});

const executionStatusText = computed(() => {
  if (llmRetryState.value && isLoading.value) {
    return `重试中 · ${formatRetryCountdown(llmRetryState.value)}`;
  }
  const status = sessionTaskInfo.value?.status;
  if (status === 'cancel_requested') return '停止中';
  if (status === 'running' || isLoading.value) return '运行中';
  if (status === 'interrupted') return '已中断';
  if (status === 'failed') return '失败';
  if (status === 'completed') return '已完成';
  return '空闲';
});

const executionStatusClass = computed(() => {
  if (llmRetryState.value && isLoading.value) return 'is-warning';
  const status = sessionTaskInfo.value?.status;
  if (status === 'cancel_requested') return 'is-warning';
  if (isLoading.value || status === 'running') return 'is-running';
  if (status === 'failed') return 'is-error';
  if (status === 'interrupted') return 'is-warning';
  if (status === 'completed') return 'is-success';
  return 'is-running';
});

/** pill 常驻显示当前会话最近一次 execution 快照；运行中优先，其次保留完成态 */
const showExecutionPill = computed(() => {
  if (!currentSessionId.value) return false;
  if (isLoading.value) return true;
  if (sessionExecutionObservability.value?.task_id || sessionExecutionObservability.value?.run_id) return true;
  const status = sessionTaskInfo.value?.status;
  return status === 'running' || status === 'cancel_requested'
    || status === 'interrupted' || status === 'failed' || status === 'completed';
});

const executionKindLabel = computed(() => {
  const kind = sessionExecutionObservability.value?.execution_kind || 'agent_stream';
  const labels = {
    agent_stream: 'Agent Stream',
    node_execute: 'Node Execute',
    mcp_tool_call: 'MCP Tool',
    mcp_connect: 'MCP Connect',
    mcp_disconnect: 'MCP Disconnect',
    mcp_refresh: 'MCP Refresh',
    mcp_test: 'MCP Test'
  };
  return labels[kind] || kind;
});

const executionStatusTooltip = computed(() => {
  const obs = sessionExecutionObservability.value || {};
  return [
    `状态: ${executionStatusText.value}`,
    llmRetryState.value ? `重试: 第 ${llmRetryState.value.nextAttempt}/${llmRetryState.value.maxAttempts} 次` : null,
    llmRetryState.value ? `等待: ${formatRetryCountdown(llmRetryState.value)}` : null,
    llmRetryState.value?.error ? `原因: ${llmRetryState.value.error}` : null,
    obs.execution_kind ? `类型: ${obs.execution_kind}` : null,
    obs.task_id ? `task_id: ${obs.task_id}` : null,
    obs.run_id ? `run_id: ${obs.run_id}` : null,
  ].filter(Boolean).join('\n');
});

function parseMessageParts(msg) {
  const contents = msg.multimodalContents || [];
  const content = msg.content || '';

  // 新格式：[viz:artifact_id]
  const VIZ_RE = /\[viz:(viz_\w+)\]/g;
  // 旧格式兼容：[CHART:N]
  const CHART_RE = /\[CHART:(\d+)\]/g;

  const hasViz = VIZ_RE.test(content);
  VIZ_RE.lastIndex = 0;
  const hasChart = CHART_RE.test(content);
  CHART_RE.lastIndex = 0;

  // 无任何占位符
  if (!hasViz && !hasChart) {
    if (!contents.length) {
      return [{ type: 'text', content }];
    }
    // 有旧格式 multimodal 但无占位符，追加到末尾
    return [
      { type: 'text', content },
      ...contents.map((c, i) => ({ type: 'chart', index: i }))
    ];
  }

  // 统一正则匹配两种格式
  const COMBINED_RE = /\[viz:(viz_\w+)\]|\[CHART:(\d+)\]/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = COMBINED_RE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    if (match[1]) {
      // 新格式 [viz:artifact_id]
      parts.push({ type: 'viz', artifactId: match[1] });
    } else if (match[2]) {
      // 旧格式 [CHART:N] 兼容
      const chartIdx = parseInt(match[2], 10) - 1;
      if (chartIdx >= 0 && chartIdx < contents.length) {
        parts.push({ type: 'chart', index: chartIdx });
      }
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return parts;
}

function getChartComponent(item) {
  return TYPE_TO_COMPONENT[item?.type] || ChartRenderer;
}

function getChartProps(item) {
  if (!item) return {};
  const fn = TYPE_TO_PROPS[item.type];
  return fn ? fn(item) : {};
}

const copyToClipboard = async (text) => {
  try {
    if (typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function' &&
        typeof window !== 'undefined' &&
        window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // 忽略错误，继续走后备方案
  }

  // 回退到隐藏 textarea + execCommand（兼容部分手机浏览器）
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(textarea);
    return !!ok;
  } catch (e) {
    return false;
  }
};

const startEditMessage = (msg, index) => {
  const idx = messages.value.findIndex(m => m === msg);
  editingMessageIndex.value = idx >= 0 ? idx : index;
  editingDraft.value = msg.content || '';
  nextTick(() => {
    const el = document.querySelector(`.user-text.is-editing[data-msg-id="${msg.id}"]`)
              || document.querySelector('.user-text.is-editing');
    if (!el) return;
    el.focus();
    // 光标移到末尾
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
};

const cancelEdit = () => {
  editingMessageIndex.value = null;
  editingDraft.value = '';
};

/** 编辑后确定：先回退到该条之前，再以编辑后的内容流式发送（保持原有流式体验） */
const confirmEditAndResend = async () => {
  const idx = editingMessageIndex.value;
  if (idx == null) return;
  const msg = messages.value[idx];
  if (!msg || msg.role !== 'user') {
    cancelEdit();
    return;
  }
  const content = (editingDraft.value || '').trim();
  if (!content) {
    showToast('内容不能为空');
    return;
  }
  const sessionId = currentSessionId.value;
  if (!sessionId) { cancelEdit(); return; }
  const prevMessages = messages.value.slice();
  messages.value = messages.value.slice(0, idx);
  cacheMessages(sessionId, messages.value);
  try {
    let body;
    if (idx === 0) {
      body = { after_seq: -1 };
    } else {
      const prev = messages.value[idx - 1];
      body = prev.id ? { after_message_id: prev.id } : (prev.seq != null ? { after_seq: prev.seq } : { after_seq: -1 });
    }
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || '回退失败');
    }
    inputMessage.value = content;
    cancelEdit();
    await nextTick();
    handleSend();
  } catch (e) {
    messages.value = prevMessages;
    cacheMessages(sessionId, prevMessages);
    cancelEdit();
    showToast(e.message || '操作失败');
  }
};

/** 重试：仅回退到该条之后，再用原问题流式发送（与正常发送一致，有流式输出） */
const rollbackAndRetry = async (msg) => {
  const sessionId = currentSessionId.value;
  if (!sessionId) {
    showToast('当前无会话');
    return;
  }
  if (msg.role !== 'user' || msg.seq == null) {
    showToast('仅支持从用户消息重试，且需已加载序号');
    return;
  }
  const idx = messages.value.findIndex(m => m === msg || (m.role === 'user' && m.seq === msg.seq));
  if (idx < 0) return;
  const prevMessages = messages.value.slice();
  try {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ after_seq: msg.seq - 1 })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || '回退失败');
    }
    messages.value = messages.value.slice(0, idx);
    cacheMessages(sessionId, messages.value);
    inputMessage.value = (msg.content || '').trim();
    await nextTick();
    handleSend();
  } catch (e) {
    messages.value = prevMessages;
    cacheMessages(sessionId, prevMessages);
    showToast(e.message || '回退失败');
  }
};

const copyMessage = async (msg) => {
  const text = (msg.content || '').trim();
  if (!text) {
    showToast('无内容可复制');
    return;
  }
  const ok = await copyToClipboard(text);
  if (ok) {
    showToast('已复制到剪贴板', 'success');
  } else {
    showToast('复制失败');
  }
};

const confirmDeleteSession = async (item) => {
  confirmDialog.value = {
    title: '删除会话',
    message: `确定要删除会话"${item.title || formatTitle(item) || 'New Conversation'}"吗？此操作不可恢复。`,
    confirmText: '删除',
    cancelText: '取消',
    onConfirm: () => {
      deleteSession(item.session_id);
    },
    onCancel: () => {}
  };
  confirmDialogRef.value?.show();
};

const deleteSession = async (sessionId) => {
  try {
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || '删除失败');
    }

    // 从历史列表中移除
    const index = history.value.findIndex(h => h.session_id === sessionId);
    if (index >= 0) {
      history.value.splice(index, 1);
    }

    // 如果删除的是当前会话，清空消息并跳转到首页
    if (currentSessionId.value === sessionId) {
      startNewChat();
    }

    // 从缓存中移除
    if (messageCache.value.has(sessionId)) {
      messageCache.value.delete(sessionId);
    }

    showToast('会话已删除', 'success');
  } catch (error) {
    showToast(error.message || '删除会话失败');
  }
};

const ensureSession = async () => {
  if (currentSessionId.value) return currentSessionId.value;
  const userId = (localStorage.getItem('userId') || '').trim();
  const body = userId ? { user_id: userId } : {};
  const response = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  const result = await response.json();
  currentSessionId.value = result.data?.session_id || null;
  if (currentSessionId.value) {
    window.history.pushState({}, '', `/chat/${encodeURIComponent(currentSessionId.value)}`);
  }
  return currentSessionId.value;
};

const handleStop = async () => {
  if (!currentSessionId.value) return;

  try {
    // 先通知后端终止
    await fetch('/api/agent/stream/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: currentSessionId.value })
    });
    sessionTaskInfo.value = {
      ...(sessionTaskInfo.value || {}),
      status: 'cancel_requested'
    };
  } catch (e) {
    console.warn('停止请求发送失败:', e);
  }

  // 然后断开 SSE 接收
  if (currentStreamController.value) {
    currentStreamController.value.abort();
    currentStreamController.value = null;
  }

  // 标记当前助手消息已完成
  const lastMsg = messages.value[messages.value.length - 1];
  if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.finished) {
    lastMsg.stopped = true;
    lastMsg.finished = true;
  }

  isLoading.value = false;
};

const openExecutionDrawer = async () => {
  execDrawerVisible.value = true;
  execDiagnosticsError.value = '';
  if (currentSessionId.value) {
    await refreshSessionExecutionDiagnostics(currentSessionId.value, { silent: false });
  }
};

const closeExecutionDrawer = () => {
  execDrawerVisible.value = false;
};

/**
 * 通用 SSE 流处理：读取 response body 并分发事件到 UI
 * handleSend 和 reconnectToRunningTask 共用
 *
 * @param {Response} response - fetch 返回的 Response 对象
 * @param {number} assistantMsgIndex - 当前 assistant 消息在 messages 中的索引
 * @param {string} sessionId - 会话 ID
 */
const processSSEStream = async (response, assistantMsgIndex, sessionId, streamToken) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';  // 缓冲跨 chunk 的不完整 SSE 事件
    // 重连模式标记：收到 reconnect_start 后进入回放阶段，收到 reconnect_end 结束
    let isReplaying = false;
    let lastSeenSeq = 0;  // 事件序号 gap 检测
    const isActiveStream = () =>
      activeStreamToken.value === streamToken && currentSessionId.value === sessionId;

    while (true) {
      if (!isActiveStream()) {
        try { await reader.cancel(); } catch (_) {}
        break;
      }
      const { done, value } = await reader.read();
      if (done) {
        if (!isActiveStream()) break;
        clearLlmRetryState();
        const currentMsg = messages.value[assistantMsgIndex];
        if (!currentMsg) break;
        currentMsg.finished = true;
        if (currentMsg.toolCallRegistry) currentMsg.toolCallRegistry.clear();
        const assistantContent = currentMsg.content;
        if (assistantContent) {
          updateRecentSession(sessionId, assistantContent, new Date().toISOString());
        }
        cacheMessages(sessionId, messages.value);
        // 检查是否需要触发态势大屏
        checkSituationScreenTrigger(assistantContent);
        break;
      }

      sseBuffer += decoder.decode(value, { stream: true });
      const parts = sseBuffer.split('\n\n');
      // 最后一段可能不完整，保留到下次
      sseBuffer = parts.pop() || '';

      for (const line of parts) {
        if (line.startsWith('data: ')) {
          try {
            if (!isActiveStream()) {
              try { await reader.cancel(); } catch (_) {}
              break;
            }
            const event = JSON.parse(line.substring(6));
            if (event.type !== 'heartbeat' && event.session_id !== sessionId) {
              continue;
            }
            const currentMsg = messages.value[assistantMsgIndex];
            if (!currentMsg) {
              continue;
            }
            mergeExecutionObservability(event);

            // ── 重连协议：reconnect_start / reconnect_end ──
            if (event.type === 'reconnect_start') {
              sessionTaskInfo.value = {
                ...(sessionTaskInfo.value || {}),
                task_id: event.task_id || sessionTaskInfo.value?.task_id,
                session_id: event.session_id || sessionTaskInfo.value?.session_id || sessionId,
                run_id: event.run_id || sessionTaskInfo.value?.run_id,
                execution_kind: event.execution_kind || sessionTaskInfo.value?.execution_kind,
                request_id: event.request_id || sessionTaskInfo.value?.request_id,
                status: 'running'
              };
              isReplaying = true;
              continue;
            }
            if (event.type === 'reconnect_end') {
              isReplaying = false;
              continue;
            }
            // 回放阶段跳过心跳和 done
            if (isReplaying && (event.type === 'heartbeat' || event.type === 'done')) {
              continue;
            }

            // ✨ 提取事件数据（完整Event对象格式）
            const eventData = event.data || {};
            const eventType = event.type;

            if (
              llmRetryState.value
              && eventType !== 'agent.retry_scheduled'
              && (
                eventType === 'agent.intent_delta'
                || eventType === 'agent.intent_complete'
                || eventType === 'call.tool.start'
                || eventType === 'output.chunk'
                || eventType === 'output.final_answer'
                || eventType === 'agent.end'
                || eventType === 'agent.error'
                || eventType === 'done'
              )
            ) {
              clearLlmRetryState();
            }

            // 事件序号 gap 检测
            if (eventType === 'heartbeat') {
              const hbLastSeq = event.last_seq || 0;
              const hbDropped = event.dropped_count || 0;
              if (hbLastSeq > lastSeenSeq + 1) {
                console.warn(`[SSE] 心跳检测到事件 gap: lastSeenSeq=${lastSeenSeq}, server.last_seq=${hbLastSeq}, dropped=${hbDropped}`);
              }
              lastSeenSeq = Math.max(lastSeenSeq, hbLastSeq);
              continue;
            }
            if (event.seq) {
              if (lastSeenSeq > 0 && event.seq > lastSeenSeq + 1) {
                console.warn(`[SSE] 事件序号 gap: expected=${lastSeenSeq + 1}, got=${event.seq}, missed=${event.seq - lastSeenSeq - 1}`);
              }
              lastSeenSeq = event.seq;
            }

            // 🎯 使用与持久化相同的解析逻辑，统一「被调用 Agent」与展示名
            const { calledAgent: calledAgentForStart, displayName: displayNameForStart } = getCalledAgentAndDisplayName(event);
            if (eventType === 'agent.retry_scheduled') {
              const waitMs = Number.isFinite(eventData.wait_ms) ? eventData.wait_ms : Math.round((eventData.wait_seconds || 0) * 1000);
              setLlmRetryState({
                scope: eventData.scope || 'chat_completion_stream',
                nextAttempt: eventData.next_attempt || ((eventData.failed_attempt || 0) + 1),
                maxAttempts: eventData.max_attempts || 1,
                waitMs,
                error: eventData.error || '',
                provider: eventData.provider || '',
                model: eventData.model || '',
              });
              sessionTaskInfo.value = {
                ...(sessionTaskInfo.value || {}),
                status: 'running',
              };
            }
            else if (isSubtaskStartEvent(eventType, calledAgentForStart, event.parent_call_id)) {
              if (currentMsg.subtasks.length > 0) {
                currentMsg.subtasks.forEach(st => st.expanded = false);
              }

              const existingSubtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
              const subtaskState = buildSubtaskState({
                eventData,
                fallbackRound: getLatestRound(currentMsg.execution_steps),
                existing: existingSubtask,
                calledAgent: calledAgentForStart,
                displayName: displayNameForStart,
                taskId: event.call_id,
                parentCallId: event.parent_call_id,
              });
              if (existingSubtask) {
                Object.assign(existingSubtask, subtaskState);
              } else {
                currentMsg.subtasks.push(subtaskState);
              }
            }
            // 🎯 编排器的 intent（流式增量）
            else if (eventType === 'agent.intent_delta') {
              if (isMasterEvent(event)) {
                if (!currentMsg.execution_steps) currentMsg.execution_steps = [];
                let lastStep = currentMsg.execution_steps[currentMsg.execution_steps.length - 1];
                // 新建条件：无 step / 已完成 / 上一轮的空 step（round 不同且 intent 为空）
                if (!lastStep || lastStep._intentComplete || (lastStep.round !== eventData.round && !lastStep.intent)) {
                  lastStep = { round: eventData.round, intent: '', toolCalls: [], expanded: true };
                  currentMsg.execution_steps.push(lastStep);
                }
                lastStep.intent += eventData.content;
              } else {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) {
                  let step = subtask.currentStep;
                  if (!step || step._intentComplete || (step.round !== eventData.round && !step.intent)) {
                    step = { round: eventData.round, intent: '', toolCalls: [], expanded: true };
                    subtask.react_steps.push(step);
                    subtask.currentStep = step;
                  }
                  step.intent += eventData.content;
                }
              }
            }
            // intent 完成：携带完整内容，直接用于创建或收尾 step
            else if (eventType === 'agent.intent_complete') {
              if (isMasterEvent(event)) {
                if (!currentMsg.execution_steps) currentMsg.execution_steps = [];
                const lastStep = currentMsg.execution_steps[currentMsg.execution_steps.length - 1];
                if (lastStep && lastStep.intent) {
                  // delta 已填充内容，标记完成即可
                  lastStep._intentComplete = true;
                } else {
                  // 未收到 delta（异常情况），用完整内容兜底建 step
                  currentMsg.execution_steps.push({
                    round: eventData.round,
                    intent: eventData.content || '',
                    toolCalls: [],
                    expanded: true,
                    _intentComplete: true
                  });
                }
              } else {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) {
                  const step = subtask.currentStep;
                  if (step && step.intent) {
                    // delta 已填充内容，标记完成即可
                    step._intentComplete = true;
                  } else {
                    // 未收到 delta（异常情况），用完整内容兜底建 step
                    const newStep = {
                      round: eventData.round,
                      intent: eventData.content || '',
                      toolCalls: [],
                      expanded: true,
                      _intentComplete: true
                    };
                    subtask.react_steps.push(newStep);
                    subtask.currentStep = newStep;
                  }
                }
              }
            }
            // 工具调用
            else if (eventType === 'call.tool.start') {
              // 先尝试找子 Agent subtask（parent_call_id 对应某个 subtask.task_id）
              let subtask = findSubtaskByCallId(currentMsg.subtasks, event.parent_call_id);
              // 容错：parent_call_id 存在但 subtask 缺失（重连回放时 call.agent.start 事件可能丢失），
              // 创建占位 subtask 避免工具被错误地挂到编排器层级
              if (!subtask && event.parent_call_id && !isMasterEvent(event)) {
                subtask = buildSubtaskState({
                  eventData,
                  fallbackRound: getLatestRound(currentMsg.execution_steps),
                  calledAgent: event.agent_name || eventData.agent_name || '',
                  displayName: event.agent_name || eventData.agent_name || '',
                  taskId: event.parent_call_id,
                  parentCallId: null,
                });
                currentMsg.subtasks.push(subtask);
              }
              if (subtask) {
                // 跨轮次时需要新建 step，避免 tool 挂到上一轮的空 step 上
                const subtaskToolRound = eventData.round ?? subtask.currentStep?.round ?? 1;
                if (!subtask.currentStep || (subtask.currentStep.round !== subtaskToolRound && !subtask.currentStep.intent && subtask.currentStep.toolCalls.every(t => t.status !== 'running'))) {
                  const newStep = {
                    round: subtaskToolRound,
                    intent: '',
                    toolCalls: [],
                    expanded: true
                  };
                  subtask.react_steps.push(newStep);
                  subtask.currentStep = newStep;
                }
                const toolCall = {
                  call_id: event.call_id,
                  tool_name: eventData.tool_name,
                  arguments: eventData.arguments,
                  status: 'running',
                  result: '',
                  result_preview: '',
                  raw_result: null,
                  raw_result_ref: null,
                  raw_result_available: false,
                  index: eventData.index,
                  total: eventData.total,
                  showResult: false,
                  showArgs: false
                };
                subtask.currentStep.toolCalls.push(toolCall);
                subtask.tool_calls.push(toolCall);
                // 注册到 registry，供 tool.end 精确匹配
                if (event.call_id && currentMsg.toolCallRegistry) {
                  currentMsg.toolCallRegistry.set(event.call_id, { toolCall, target: subtask.currentStep });
                }
              } else {
                // 编排器直接调用工具：工具归属于当前轮次的 step
                // 跨轮次且上一轮是空 step（无 intent、无运行中工具）时需要新建
                if (!currentMsg.execution_steps) currentMsg.execution_steps = [];
                let executionStep = currentMsg.execution_steps[currentMsg.execution_steps.length - 1];
                // 当 eventData.round 缺失时（如 LLM 跳过 <intent> 直接输出 <tools>），
                // fallback 到已有 step 的 round，避免创建 round=undefined 的幽灵 step
                const toolRound = eventData.round ?? executionStep?.round ?? 1;
                if (!executionStep || (executionStep.round !== toolRound && !executionStep.intent && executionStep.toolCalls.every(t => t.status !== 'running'))) {
                  executionStep = {
                    round: toolRound,
                    intent: '',
                    toolCalls: [],
                    expanded: true
                  };
                  currentMsg.execution_steps.push(executionStep);
                }
                const toolCall = {
                  call_id: event.call_id,
                  tool_name: eventData.tool_name,
                  arguments: eventData.arguments,
                  status: 'running',
                  result: '',
                  result_preview: '',
                  raw_result: null,
                  raw_result_ref: null,
                  raw_result_available: false,
                  index: eventData.index,
                  total: eventData.total,
                  showResult: false,
                  showArgs: false
                };
                executionStep.toolCalls.push(toolCall);
                // 注册到 registry，供 tool.end 精确匹配
                if (event.call_id && currentMsg.toolCallRegistry) {
                  currentMsg.toolCallRegistry.set(event.call_id, { toolCall, target: executionStep });
                }
              }
            }
            else if (eventType === 'call.tool.end') {
              const toolEndStatus = eventData.success === false ? 'error' : 'success';
              // 优先通过 registry 精确匹配（同时覆盖 subtask 和 master_step）
              const registered = event.call_id && currentMsg.toolCallRegistry?.get(event.call_id);
              if (registered) {
                registered.toolCall.status = toolEndStatus;
                registered.toolCall.result = getToolPreviewResult(eventData);
                registered.toolCall.result_preview = getToolPreviewResult(eventData);
                registered.toolCall.raw_result = hasToolRawResult(eventData) ? eventData.raw_result : null;
                registered.toolCall.raw_result_ref = eventData.raw_result_ref || null;
                registered.toolCall.raw_result_available = getToolRawResultAvailable(eventData);
                registered.toolCall.elapsed_time = eventData.elapsed_time || eventData.execution_time;
                currentMsg.toolCallRegistry.delete(event.call_id);
              } else {
                // fallback: 通过 parent_call_id 找 subtask
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.parent_call_id);
                if (subtask) {
                  const tc = subtask.tool_calls.find(t => t.tool_name === eventData.tool_name && t.status === 'running');
                  if (tc) {
                    tc.status = toolEndStatus;
                    tc.result = getToolPreviewResult(eventData);
                    tc.result_preview = getToolPreviewResult(eventData);
                    tc.raw_result = hasToolRawResult(eventData) ? eventData.raw_result : null;
                    tc.raw_result_ref = eventData.raw_result_ref || null;
                    tc.raw_result_available = getToolRawResultAvailable(eventData);
                    tc.elapsed_time = eventData.elapsed_time || eventData.execution_time;
                  }
                } else {
                  // fallback：在 execution_steps 中查找
                  const executionSteps = currentMsg.execution_steps;
                  if (executionSteps) {
                    for (const step of executionSteps) {
                      const tc = (step.toolCalls || []).find(t => t.tool_name === eventData.tool_name && t.status === 'running');
                      if (tc) {
                        tc.status = toolEndStatus;
                        tc.result = getToolPreviewResult(eventData);
                        tc.result_preview = getToolPreviewResult(eventData);
                        tc.raw_result = hasToolRawResult(eventData) ? eventData.raw_result : null;
                        tc.raw_result_ref = eventData.raw_result_ref || null;
                        tc.raw_result_available = getToolRawResultAvailable(eventData);
                        tc.elapsed_time = eventData.elapsed_time || eventData.execution_time;
                        break;
                      }
                    }
                  }
                }
              }
            }
            // 🎯 三种「结束」事件职责区分：
            // - call.agent.end：子 Agent/子任务结束，只更新对应 subtask 的 result_summary、status
            // - output.final_answer：最终答案内容 + 标记本条消息完成（finished）
            // - agent.end：主 Agent 整体结束，仅作兜底（若尚未 finished 则标记完成），不重复处理内容

            // 子任务/子 Agent 调用结束：只更新对应卡片（用 data.agent_name 判断，编排器自身的 end 跳过）
            else if (isSubtaskEndEvent(eventType, eventData.agent_name != null ? eventData.agent_name : event.agent_name, event.parent_call_id)) {
              const calledAgent = eventData.agent_name != null ? eventData.agent_name : event.agent_name;
              if (calledAgent && !isOrchestratorAgentName(calledAgent)) {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) {
                  subtask.result_summary = eventData.subtask_result || eventData.result_summary || eventData.result;
                  subtask.status = eventData.success === false ? 'error' : 'success';
                  subtask.expanded = false;
                }
              }
            }
            // 最终答案（完整）：内容 + 元数据 + 标记消息完成
            // （流式内容已由 output.chunk 拼接，此处仅兜底与标记）
            else if (eventType === 'output.chunk') {
              if (isMasterEvent(event)) {
                currentMsg.content += eventData.content;
                scrollToBottom();
              } else {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) subtask.result_summary = (subtask.result_summary || '') + eventData.content;
              }
            }
            // 最终答案完成信号：仅标记 finished 并写入 metadata，content 已由 output.chunk 流式拼接
            // id/seq 由独立的 output.message_saved 事件补全（持久化与 SSE 解耦）
            else if (eventType === 'output.final_answer') {
              if (isMasterEvent(event)) {
                Object.assign(currentMsg, {
                  ...(eventData.metadata ? { metadata: eventData.metadata } : {}),
                  finished: true,
                });
                updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
                cacheMessages(sessionId, messages.value);
              } else {
                // 子 agent 的 final_answer 足以说明该子任务已完成。
                // 即使后续 call.agent.end 丢失，也不应继续停留在 running。
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) {
                  if (!subtask.result_summary) subtask.result_summary = eventData.content || '';
                  if (subtask.status === 'running') subtask.status = 'success';
                  subtask.expanded = false;
                }
              }
            }
            // 消息持久化完成：补全 id/seq（由后端写库后发布，与 FINAL_ANSWER 解耦）
            else if (eventType === 'output.message_saved') {
              const target = eventData.role === 'user'
                ? messages.value[assistantMsgIndex - 1]
                : currentMsg;
              if (target) {
                if (eventData.id != null) target.id = eventData.id;
                if (eventData.seq != null) target.seq = eventData.seq;
              }
              cacheMessages(sessionId, messages.value);
            }
            // 主 Agent 结束：仅兜底标记完成（若未在 output.final_answer 中标记）
            else if (eventType === 'agent.end' && isMasterEvent(event)) {
              if (!currentMsg.finished) {
                currentMsg.finished = true;
                if (currentMsg.content) {
                  updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
                }
                // 检查是否需要触发态势大屏
                checkSituationScreenTrigger(currentMsg.content);
              }
            }
            // 图表/地图等可视化事件（注册表驱动）
            else if (VISUALIZATION_REGISTRY[eventType]) {
              currentMsg.multimodalContents.push(
                VISUALIZATION_REGISTRY[eventType].extract(eventData)
              );
            }
            // 错误
            else if (eventType === 'agent.error') {
              currentMsg.status.push({ type: 'error', content: eventData.error || eventData.content });
            }
            else if (eventType === 'done') {
              sessionTaskInfo.value = {
                ...(sessionTaskInfo.value || {}),
                task_id: event.task_id || sessionTaskInfo.value?.task_id,
                session_id: event.session_id || sessionTaskInfo.value?.session_id || sessionId,
                run_id: event.run_id || sessionTaskInfo.value?.run_id,
                execution_kind: event.execution_kind || sessionTaskInfo.value?.execution_kind,
                request_id: event.request_id || sessionTaskInfo.value?.request_id,
                thread_alive: false,
                status: 'completed'
              };
            }
            // 上下文用量
            else if (eventType === 'context.usage') {
              if (eventData.compressing) isCompressing.value = true;
              const agentName = event.agent_name;
              const ctx = { used: eventData.used_tokens, max: eventData.budget_tokens };
              if (isOrchestratorAgentName(agentName)) {
                contextUsage.value = ctx;
              } else {
                // 写入对应 subtask
                const subtask = currentMsg.subtasks.find(s => s.agent_name === agentName && s.status === 'running');
                if (subtask) subtask.ctx = ctx;
              }
            }
            // 上下文压缩开始
            else if (eventType === 'context.compression_start') {
              isCompressing.value = true;
            }
            // 上下文压缩完成
            else if (eventType === 'context.compression_summary') {
              isCompressing.value = false;
            }

            // 工具审批请求：弹出确认对话框，等待用户操作
            else if (eventType === 'user.approval_required') {
              // 审批响应回调（复用）
              const makeApprovalResponder = (approved) => async (aid, message) => {
                try {
                  const resp = await fetch(
                    `/api/agent/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(aid)}/respond`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ approved, message })
                    }
                  );
                  if (!resp.ok) {
                    const result = await resp.json().catch(() => ({}));
                    throw new Error(result.message || `审批提交失败 (${resp.status})`);
                  }
                } catch (e) {
                  console.warn('审批响应失败:', e);
                  showToast(e.message || '审批提交失败', 'warning');
                }
              };

              if (eventData.approval_type === 'file_read_confirm') {
                // 大文件预览确认对话框
                filePreviewDialogRef.value?.show(
                  eventData,
                  makeApprovalResponder(true),
                  makeApprovalResponder(false)
                );
              } else {
                // 通用工具审批对话框
                approvalDialogRef.value?.show(
                  { ...eventData, agent_name: event.agent_name || eventData.agent_name || '智能体' },
                  makeApprovalResponder(true),
                  makeApprovalResponder(false)
                );
              }
            }

            // 用户输入请求：弹出遮罩输入对话框
            else if (eventType === 'user.input_required') {
              const inputSessionId = sessionId;

              userInputDialogRef.value?.show(
                eventData,
                // onSubmit: 用户提交 → POST 到后端
                async (inputId, value) => {
                  try {
                    const resp = await fetch(
                      `/api/agent/sessions/${encodeURIComponent(inputSessionId)}/inputs/${encodeURIComponent(inputId)}/respond`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ value })
                      }
                    );
                    if (!resp.ok) {
                      const result = await resp.json().catch(() => ({}));
                      throw new Error(result.message || `用户输入提交失败 (${resp.status})`);
                    }
                  } catch (e) {
                    console.warn('用户输入提交失败:', e);
                    showToast(e.message || '用户输入提交失败', 'warning');
                  }
                },
                // onCancel: 停止任务
                async (_inputId) => {
                  await handleStop();
                }
              );
            }

            scrollToBottom();
          } catch (e) {
            console.error('Error parsing SSE data:', e);
          }
        }
      }
    }
};

// ── 态势大屏触发逻辑 ─────────────────────────────────────────────
const checkSituationScreenTrigger = async (content) => {
  if (!content || situationScreenActive.value) return;

  // 查找 [viz:xxx] 占位符
  const VIZ_RE = /\[viz:(viz_\w+)\]/g;
  const matches = [...content.matchAll(VIZ_RE)];
  if (!matches.length) return;

  // 从后往前找最新的 viz artifact
  for (let i = matches.length - 1; i >= 0; i--) {
    const artifactId = matches[i][1];
    try {
      const resp = await fetch(`/api/artifacts/visualizations/${encodeURIComponent(artifactId)}`);
      if (!resp.ok) continue;
      const result = await resp.json();
      const vizData = result;
      if (vizData.viz_type !== 'map') continue;

      const mapData = vizData.config;
      const mapType = mapData.map_type;

      // 只有 risk 和 bindmap 自动触发
      if (mapType === 'risk' || mapType === 'bindmap') {
        situationArtifactId.value = artifactId;
        situationMapData.value = mapData;
        situationInfo.value = mapData.assessment_summary || null;
        situationScreenActive.value = true;
        return;
      }
    } catch (e) {
      console.warn('检查态势大屏触发失败:', e);
    }
  }
};

const handleSituationSendMessage = (text) => {
  // 在态势大屏中发送消息：复用主聊天的发送逻辑
  inputMessage.value = text;
  nextTick(() => handleSend());
};

const handleEnterSituation = ({ artifactId, mapData, vizData }) => {
  // 手动触发态势大屏（从 MapRenderer 的按钮点击）
  situationArtifactId.value = artifactId;
  situationMapData.value = mapData;
  situationInfo.value = mapData?.assessment_summary || null;
  situationScreenActive.value = true;
};

const handleSend = async () => {
  const content = inputMessage.value.trim();
  if (!content || isLoading.value) return;

  const sessionId = await ensureSession();

  // ── 后端双重检查：防止并发 ──
  try {
    const statusResp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
    if (statusResp.ok) {
      const result = await statusResp.json();
      sessionTaskInfo.value = result.data?.task_info || null;
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
      if (result.data?.has_running_task) {
        showToast('该会话正在执行任务，请等待完成或先停止', 'warning');
        return;
      }
    }
  } catch (_) { /* 查询失败不阻塞发送 */ }

  lastFailedSendContent.value = content;
  messages.value.push({ role: 'user', content: content });
  inputMessage.value = '';
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;
  scrollToBottom(true);
  updateRecentSession(sessionId, content, new Date().toISOString());

  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    subtasks: [],
    execution_steps: [],
    showFullSubtasks: false,
    multimodalContents: [],
    status: [],
    toolCallRegistry: new Map(),
    finished: false
  }) - 1;

  beginOptimisticExecutionState(sessionId);
  isLoading.value = true;
  contextUsage.value = { used: 0, max: 0 };
  const streamToken = activeStreamToken.value + 1;

  try {
    const controller = new AbortController();
    activeStreamToken.value = streamToken;
    currentStreamController.value = controller;
    const body = {
      task: content,
      session_id: sessionId,
      use_v2: true
    };
    // 前端 llm-select-trigger 选择：临时指定默认主智能体及未配置 LLM 的智能体使用的模型（格式 provider|provider_type|model_name）
    const selectedLlm = props.selectedLLM || localStorage.getItem('selectedLLMModel') || '';
    if (selectedLlm) {
      body.selected_llm = selectedLlm;
    }
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    await processSSEStream(response, assistantMsgIndex, sessionId, streamToken);
  } catch (error) {
    clearLlmRetryState();
    if (error.name === 'AbortError') {
      console.log('Stream aborted by user');
      if (!sessionTaskInfo.value?.status || sessionTaskInfo.value.status === 'running') {
        sessionTaskInfo.value = {
          ...(sessionTaskInfo.value || {}),
          status: 'interrupted'
        };
      }
    } else {
      console.error('Error sending message:', error);
      messages.value[assistantMsgIndex].content += '\n\n[System Error: Request failed]';
      messages.value[assistantMsgIndex].finished = true;
      sessionTaskInfo.value = {
        ...(sessionTaskInfo.value || {}),
        status: 'failed'
      };
      showToast('消息发送失败', async () => {
        if (lastFailedSendContent.value) {
          inputMessage.value = lastFailedSendContent.value;
          await nextTick();
          handleSend();
        }
      });
    }
  } finally {
    clearLlmRetryState();
    isCompressing.value = false;
    isLoading.value = false;
    await refreshSessionExecutionState(sessionId, { silent: true });
    window.setTimeout(() => {
      refreshSessionExecutionState(sessionId, { silent: true });
    }, 600);
    scrollToBottom();
    if (activeStreamToken.value === streamToken) {
      currentStreamController.value = null;
    }
  }
};

onMounted(() => {
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;

  // 初始化移动端检测
  checkMobile();

  // 监听窗口大小变化
  window.addEventListener('resize', checkMobile);
  window.addEventListener('popstate', handlePopState);
  loadRecentSessions(true);
  const initialSessionId = (() => {
    const match = window.location.pathname.match(/^\/chat\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  })();
  if (initialSessionId) {
    currentSessionId.value = initialSessionId;
    loadSessionMessages(initialSessionId);
  }
});

onUnmounted(() => {
  // 清理事件监听器
  window.removeEventListener('resize', checkMobile);
  window.removeEventListener('popstate', handlePopState);
  stopRetryTicker();

  // 不再通知后端停止任务 — Agent 继续在后台执行

  invalidateActiveStream();

  // 恢复 body 滚动（防止移动端打开侧边栏后离开页面）
  document.body.style.overflow = '';
});
</script>

<style scoped src="../styles/chat-view.css"></style>
<style scoped>
/* #9: 压缩摘要卡片 - 使用项目设计变量，添加 hover/active/focus-visible */
.compression-summary { margin: 0.5rem 0; }
.compression-summary-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.85rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: var(--font-size-sm);
  user-select: none;
  transition: background var(--transition-fast), border-color var(--transition-fast);
  outline: none;
}
.compression-summary-label:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-hover);
}
.compression-summary-label:active {
  transform: scale(0.995);
}
.compression-summary-label:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
.compression-summary-title { font-weight: 600; color: var(--color-text-primary); }
.compression-summary-toggle {
  color: var(--color-brand-accent-light, var(--color-interactive));
  font-size: var(--font-size-xs);
}
.compression-summary-detail {
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-top: none;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  font-size: var(--font-size-sm);
}

/* #10: 上下文指示器 - 字体调大至满足可读性，加 hover 反馈 */
.context-usage-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  max-width: 800px;
  margin: 0 auto 6px;
  padding: 3px 8px;
  width: 100%;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.execution-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 3px 10px 3px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.execution-pill:hover {
  background: var(--color-hover-overlay);
}

.execution-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--color-text-muted);
}

.execution-pill-text {
  font-weight: 600;
  line-height: 1;
}

.execution-pill-kind {
  font-size: 11px;
  line-height: 1;
  color: var(--color-text-muted);
}

.execution-pill.is-running {
  border-color: rgba(var(--color-brand-accent-rgb), 0.3);
}

.execution-pill.is-running .execution-pill-dot {
  background: var(--color-brand-accent-light);
}

.execution-pill.is-running .execution-pill-text {
  color: var(--color-brand-accent-light);
}

.execution-pill.is-warning {
  border-color: rgba(var(--color-warning-rgb), 0.3);
}

.execution-pill.is-warning .execution-pill-dot {
  background: var(--color-warning);
}

.execution-pill.is-warning .execution-pill-text {
  color: var(--color-warning);
}

.execution-pill.is-error {
  border-color: rgba(var(--color-error-rgb), 0.3);
}

.execution-pill.is-error .execution-pill-dot {
  background: var(--color-error);
}

.execution-pill.is-error .execution-pill-text {
  color: var(--color-error);
}

.execution-pill.is-success .execution-pill-dot {
  background: var(--color-success);
}
/* .context-usage-bar:hover {
  background: var(--color-bg-secondary);
} */

.context-usage-content {
  display: inline-flex;  /* 关键：只包裹内容，不撑满宽度 */
  align-items: center;
  gap: 8px;
  cursor: pointer;       /* 只在这里设置手型 */
  /* 可选：增加一点点击热区，但不要过大 */
  padding: 4px;
  margin: -4px;
}

.context-usage-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  font-weight: 500;
}

.compressing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-brand-accent-light);
  margin-left: 6px;
}
.compressing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand-accent-light);
  animation: compressing-pulse 1.2s ease-in-out infinite;
}
@keyframes compressing-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.inline-chart-wrapper {
  margin: 12px 0;
  width: 100%;
}

@media (max-width: 600px) {
  .context-usage-bar {
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .execution-pill {
    margin-left: 0;
  }
}

/* ===== Scroll to Bottom Button ===== */
.scroll-to-bottom-btn {
  position: sticky;
  bottom: 80px;
  align-self: center;
  z-index: var(--z-sticky, 10);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  background: var(--color-bg-primary);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  transition: background var(--transition-fast), border-color var(--transition-fast), transform 0.15s ease;
  pointer-events: auto;
  margin: 0 auto -36px;
}

.scroll-to-bottom-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-hover);
  transform: scale(1.08);
}

.scroll-to-bottom-btn:active {
  transform: scale(0.95);
}

.scroll-btn-fade-enter-active,
.scroll-btn-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.scroll-btn-fade-enter-from,
.scroll-btn-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 767px) {
  .scroll-to-bottom-btn {
    bottom: 70px;
    width: 40px;
    height: 40px;
  }
}

.stopped-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--spacing-sm);
  padding: 4px 12px;
  border-radius: var(--radius-full);
  background: var(--color-warning-bg, rgba(250, 173, 20, 0.1));
  color: var(--color-warning, #faad14);
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid rgba(250, 173, 20, 0.2);
  width: fit-content;
}

.stopped-badge svg {
  flex-shrink: 0;
}


</style>
