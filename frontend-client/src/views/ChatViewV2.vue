<template>
  <div class="chat-page-shell">
    <main ref="chatMainRef" class="chat-main" :class="{ 'has-messages': messages.length > 0 }">
    <!-- 顶部控制栏 -->
      <div class="top-controls-bar glass-card" ref="topControlsBarRef">
        <!-- 左侧：汉堡菜单 + LLM 选择器 -->
        <div class="left-controls glass-card">
          <!-- 汉堡菜单按钮（移动端） -->
          <button class="hamburger-menu-btn" @click="openMobileSidebar" :title="'Open menu'">
            <IconMenu :size="20" />
          </button>

          <LLMSelector ref="llmSelectorRef" :model-value="selectedLLM" @update:model-value="emit('update:selectedLLM', $event)" />
        </div>

        <!-- 右侧：主题切换 -->
        <div class="right-controls glass-card">
          <PermissionModeSelector />
          <button
            @click="exportCurrentSession"
            class="session-export-btn version-btn top-action-btn"
            :disabled="!currentSessionId || isExportingSession"
            :title="currentSessionId ? '导出当前会话' : '当前无会话可导出'"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3v12"></path>
              <path d="m7 10 5 5 5-5"></path>
              <path d="M5 21h14"></path>
            </svg>
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
      <div class="chat-messages-wrapper" ref="messagesRef" @scroll="handleScroll" @click="handleMarkdownBlockAction">
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
            <div v-for="(msg, index) in visibleMessages" :key="messageKey(msg)" :class="['message', msg.role, { 'just-sent': msg._justSent }]" :data-msg-index="index"
              @mouseenter="messageActionsVisible = index" @mouseleave="messageActionsVisible = null">
              <!-- 斜杠命令结果 -->
              <div v-if="msg.role === 'system' && msg.metadata?.type === 'command_result'" class="message-content-wrapper">
                <CommandResultMessage :message="msg" />
              </div>
              <!-- Subtasks Container - 占满整个 message 宽度 -->
              <div v-else-if="msg.role === 'assistant' && (hasExecutionContent(msg) || !msg.finished)"
                class="subtasks-container-full">
                <!-- 常驻 Ticker (现在同时作为 Header) -->
                <SubtaskStatusTicker :subtasks="msg.subtasks" :execution-steps="msg.execution_steps" :expanded="msg.showFullSubtasks"
                  :running="!msg.finished"
                  :has-execution="msg.has_execution"
                  :loading="msg.executionStepsLoading"
                  @toggle-view="toggleExecutionView(msg)" />

                <!-- 视图切换按钮 -->
                <!-- 完整详情模式 -->
                <transition name="expand">
                  <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
                    <!-- 层次化视图 -->
                    <HierarchicalExecutionTree
                      :execution-steps="msg.execution_steps || []"
                      :subtasks="msg.subtasks || []"
                      :session-id="currentSessionId || ''"
                    />
                  </div>
                </transition>

              </div>

              <div class="message-content-wrapper" >
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
                    <!-- 停止/中断标记 -->
                    <div v-if="msg.stopped" class="stopped-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
                      <span>{{ msg.metadata?.interrupted ? '已中断' : '已停止生成' }}</span>
                    </div>
                  </template>

                  <!-- User Message -->
                  <template v-if="msg.role === 'user'">
                    <!-- 非编辑态：气泡 -->
                    <div v-if="editingMessage !== msg" class="user-bubble-wrapper message-view-mode">
                      <div class="user-text">{{ msg.content }}</div>
                      <div v-if="msg.attachments?.length" class="user-attachments">
                        <div v-for="attachment in msg.attachments" :key="attachment.file_id || attachment.id" class="user-attachment-card">
                          <img v-if="isImageAttachment(attachment)" :src="getAttachmentPreviewUrl(attachment)" :alt="attachment.original_name || attachment.stored_name" class="user-attachment-image" />
                          <div v-else class="user-attachment-file-icon">文件</div>
                          <div class="user-attachment-info">
                            <div class="user-attachment-name">{{ attachment.original_name || attachment.stored_name }}</div>
                            <div class="user-attachment-meta">{{ formatAttachmentMeta(attachment) }}</div>
                          </div>
                        </div>
                      </div>
                      <!-- Status Updates -->
                      <div v-if="msg.status && msg.status.length > 0" class="status-updates">
                        <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-tag" :class="status.type">
                          <span v-if="status.type === 'error'" class="status-icon">⚠️</span>
                          {{ status.content }}
                        </div>
                      </div>
                    </div>

                    <!-- 编辑态：编辑框 -->
                    <div v-else class="message-edit-mode">
                      <MessageEditBox
                        v-model="editingDraft"
                        :attachments="editingAttachmentsDraft"
                        :submitting="editingSubmitting"
                        :session-id="currentSessionId"
                        @confirm="confirmEditAndResend"
                        @cancel="cancelEdit"
                        @open-attachments="openSessionFilesDrawer('message-edit')"
                        @remove-attachment="removeEditingAttachment"
                      />
                    </div>
                  </template>
                </div>
              </div>


              <!-- 消息操作 -->
              <div class="message-actions" :class="{ 'visible': messageActionsVisible === index || editingMessage === msg }">
                <template v-if="msg.role === 'user' && editingMessage !== msg">
                  <button type="button" class="msg-action-btn btn-edit" :disabled="isLoading" title="编辑" @click="startEditMessage(msg)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                  </button>
                  <button type="button" class="msg-action-btn btn-copy" title="复制" @click="copyMessage(msg)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  </button>
                </template>
                <template v-if="msg.role === 'assistant' && msg.finished">
                  <button type="button" class="msg-action-btn btn-copy" title="复制" @click="copyMessage(msg)">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                  </button>
                  <button
                    v-if="visibleMessages.slice(0, index).findLast(m => m.role === 'user' && m.seq != null) != null"
                    type="button"
                    class="msg-action-btn btn-retry"
                    :disabled="isLoading"
                    title="重试"
                    @click="rollbackAndRetry(visibleMessages.slice(0, index).findLast(m => m.role === 'user' && m.seq != null))"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>
        <!-- <div class="input-area-wrapper" :class="{ 'centered': messages.length === 0 }"> -->
        <div class="bottom-dock">
          <transition name="scroll-btn-fade">
            <LiquidGlass v-if="showScrollToBottomButton" :width="40" :height="40" :radius="999"
              extra-filter="blur(2px) contrast(1.15) brightness(1.06) saturate(1.1)"
              class="scroll-to-bottom-btn" @click="onScrollToBottomClick" title="滚动到底部">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </LiquidGlass>
          </transition>
          <div class="input-area-wrapper" :class="{ 'is-sending': inputSending }">
          <div v-if="!currentSessionId" class="workspace-root-input-row">
            <label class="workspace-root-input-label">入口 Agent</label>
            <CustomSelect
              v-model="pendingEntryAgent"
              :options="entryAgentOptions"
              :disabled="entryAgentLoading"
              placeholder="使用配置默认入口 Agent"
              style="flex: 1"
            />
          </div>
          <div v-if="!currentSessionId" class="workspace-root-input-row">
            <label class="workspace-root-input-label" for="workspace-root-input">根目录</label>
            <input
              id="workspace-root-input"
              v-model="pendingWorkspaceRoot"
              type="text"
              class="workspace-root-input"
              placeholder="可选，如 E:/Users/.../Desktop"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <ChatInput
            ref="chatInputRef"
            v-model="inputMessage"
            :attachments="pendingAttachments"
            :isLoading="isLoading"
            @send="handleSend"
            @stop="handleStop"
            @openAttachments="() => openSessionFilesDrawer('composer')"
            @removeAttachment="removePendingAttachment"
          >
            <template #footerMeta>
              <div class="composer-status-row">
                <div v-if="contextUsage && contextUsage.max > 0" class="context-usage-content" @click="openCtxDrawer" title="点击查看上下文详情">
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
                <div v-if="hasStatusPopover" ref="sessionMetaContainerRef" class="session-meta-popover-anchor session-meta-popover-anchor--inline-end">
                  <button
                    type="button"
                    class="execution-pill execution-pill--popover"
                    :class="[{ 'is-expanded': sessionMetaExpanded }]"
                    title="查看会话与执行信息"
                    aria-label="查看会话与执行信息"
                    :aria-expanded="sessionMetaExpanded ? 'true' : 'false'"
                    @click="sessionMetaExpanded = !sessionMetaExpanded"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="execution-pill__icon">
                      <path d="M12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9-9 4.03-9 9 4.03 9 9 9Z" fill="none" stroke="currentColor" stroke-width="1.7"/>
                      <path d="M12 10.25v5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>
                      <path d="M12 7.4h.01" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
                    </svg>
                  </button>
                  <div v-if="sessionMetaExpanded" class="session-meta-panel session-meta-panel--end">
                    <div v-if="hasSessionMeta" class="session-meta-section">
                      <div class="session-meta-section-title">会话信息</div>
                      <div v-if="currentSessionTeam" class="session-meta-item">
                        <span class="session-meta-label">Team</span>
                        <span class="session-meta-value">{{ currentSessionTeam }}</span>
                      </div>
                      <div v-if="pendingEntryAgent" class="session-meta-item">
                        <span class="session-meta-label">Agent</span>
                        <span class="session-meta-value">{{ pendingEntryAgent }}</span>
                      </div>
                      <div v-if="pendingWorkspaceRoot" class="session-meta-item">
                        <span class="session-meta-label">目录</span>
                        <span class="session-meta-value session-meta-value--path" :title="pendingWorkspaceRoot">{{ pendingWorkspaceRoot }}</span>
                      </div>
                    </div>
                    <div v-if="showExecutionPill" class="session-meta-section">
                      <div class="session-meta-section-title">执行状态</div>
                      <div class="session-meta-item">
                        <span class="session-meta-label">状态</span>
                        <span class="session-meta-value">{{ executionStatusText }}</span>
                      </div>
                      <div v-if="sessionExecutionObservability?.execution_kind" class="session-meta-item">
                        <span class="session-meta-label">类型</span>
                        <span class="session-meta-value">{{ sessionExecutionObservability.execution_kind }}</span>
                      </div>
                      <div v-if="sessionExecutionObservability?.task_id" class="session-meta-item">
                        <span class="session-meta-label">Task</span>
                        <span class="session-meta-value session-meta-value--path" :title="sessionExecutionObservability.task_id">{{ sessionExecutionObservability.task_id }}</span>
                      </div>
                      <div v-if="sessionExecutionObservability?.run_id" class="session-meta-item">
                        <span class="session-meta-label">Run</span>
                        <span class="session-meta-value session-meta-value--path" :title="sessionExecutionObservability.run_id">{{ sessionExecutionObservability.run_id }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </ChatInput>
        </div>
      </div>
    </div>
    </main>
    <AppToast ref="toastRef" />

    <!-- 上下文快照抽屉 -->
    <ContextSnapshotDrawer
      :visible="ctxDrawerVisible"
      :session-id="currentSessionId"
      :selected-llm="ctxDrawerSelectedLlm"
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

    <SessionFilesDrawer
      :visible="sessionFilesDrawerVisible"
      :mode="sessionFilesDrawerTarget"
      :session-id="currentSessionId || ''"
      :files="sessionFiles"
      :pending-files="currentDrawerPendingFiles"
      :loading="sessionFilesLoading"
      :uploading="uploadingSessionFiles"
      :deleting-file-id="deletingSessionFileId || ''"
      @close="() => { sessionFilesDrawerVisible = false; sessionFilesDrawerTarget = 'composer'; }"
      @refresh="currentSessionId && loadSessionFiles(currentSessionId)"
      @upload="handleSessionFileSelect"
      @download="downloadSessionFileItem"
      @delete="removeSessionFile"
      @reuse="reuseSessionFileAsAttachment"
      @removePending="sessionFilesDrawerTarget === 'message-edit' ? removeEditingAttachment($event) : removePendingAttachment($event)"
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
import { ref, computed, nextTick, onMounted, onUnmounted, watch, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { renderMarkdown } from '../utils/markdown';
import { buildExecutionState, createExecutionState, applyStep } from '../utils/executionProjector';
import SubtaskStatusTicker from '../components/SubtaskStatusTicker.vue';
import HierarchicalExecutionTree from '../components/HierarchicalExecutionTree.vue';
import UserInputDialog from '../components/UserInputDialog.vue';
import ChatInput from '../components/ChatInput.vue';
import MultimodalContent from '../components/MultimodalContent.vue';
import ChartRenderer from '../components/ChartRenderer.vue';
import MapRenderer from '../components/MapRenderer.vue';
import VisualizationLoader from '../components/VisualizationLoader.vue';
import ExecutionDiagnosticsDrawer from '../components/ExecutionDiagnosticsDrawer.vue';
import SessionFilesDrawer from '../components/SessionFilesDrawer.vue';
import SituationScreen from '../components/SituationScreen.vue';
import LLMSelector from '../components/LLMSelector.vue';
import CustomSelect from '../components/CustomSelect.vue';
import MessageEditBox from '../components/MessageEditBox.vue';
import PermissionModeSelector from '../components/PermissionModeSelector.vue';
import { getAllAgentConfigs, getTeams } from '../api/agentConfig';
import { listSessionFiles, uploadSessionFiles, deleteSessionFile, getSessionFileDownloadUrl } from '../api/sessionFiles';

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
const createAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: '',
  subtasks: [],
  execution_steps: [],
  showFullSubtasks: false,
  multimodalContents: [],
  status: [],
  finished: false,
  has_execution: false,
  executionStepsLoaded: false,
  executionStepsLoading: false,
  executionStepsLoadError: '',
  run_id: null,
  ...overrides,
});

const normalizeAssistantExecutionState = (msg) => {
  if (!msg || msg.role !== 'assistant') return msg;
  const metadata = msg.metadata || {};
  msg.has_execution = Boolean(
    msg.has_execution
    || msg.run_id
    || metadata.run_id
    || (Array.isArray(msg.execution_steps) && msg.execution_steps.length > 0)
    || (Array.isArray(msg.subtasks) && msg.subtasks.length > 0)
  );
  msg.executionStepsLoaded = Boolean(
    msg.executionStepsLoaded
    || (Array.isArray(msg.execution_steps) && msg.execution_steps.length > 0)
    || (Array.isArray(msg.subtasks) && msg.subtasks.length > 0)
  );
  msg.executionStepsLoading = Boolean(msg.executionStepsLoading);
  msg.executionStepsLoadError = msg.executionStepsLoadError || '';
  msg.run_id = msg.run_id || metadata.run_id || null;
  return msg;
};

import LiquidGlass from '../components/LiquidGlass.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import ApprovalDialog from '../components/ApprovalDialog.vue';
import FilePreviewConfirmDialog from '../components/FilePreviewConfirmDialog.vue';
import ContextSnapshotDrawer from '../components/ContextSnapshotDrawer.vue';
import AppToast from '../components/AppToast.vue';
import { IconLogo, IconChevronLeft, IconChevronRight, IconDocument, IconPlus, IconNewConversation, IconMenu, IconTrash } from '../components/icons';
import { Icon } from 'leaflet';
import { getTaskExecutionDiagnostics, getTaskStatus, getMessageRunSteps } from '../api/monitoring';
import CommandResultMessage from '../components/CommandResultMessage.vue';

// Props
const props = defineProps({
  selectedLLM: {
    type: String,
    default: ''
  },
  isDark: {
    type: Boolean,
    default: true
  },
  onSessionCreated: {
    type: Function,
    default: null,
  },
  onSessionUpdated: {
    type: Function,
    default: null,
  }
});

// Emits
const emit = defineEmits(['update:selectedLLM', 'toggleTheme']);

const router = useRouter();
const route = useRoute();
const shellSidebarControl = inject('shellSidebarControl', null);
const typewriterTimers = ref(new Map());

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const inputSending = ref(false);
const messagesRef = ref(null);
const chatMainRef = ref(null);
const topControlsBarRef = ref(null);
const sessionMetaContainerRef = ref(null);
const isUserAtBottom = ref(true);
const shouldAutoScroll = ref(true);
const keepScrollButtonVisible = ref(false);
const scrollBottomGap = ref(0);
const showScrollToBottomButton = computed(() => {
  if (!messages.value.length) return false;
  return !isUserAtBottom.value || scrollBottomGap.value > 80 || keepScrollButtonVisible.value;
});

const hasSessionMeta = computed(() => Boolean(currentSessionId.value && (currentSessionTeam.value || pendingEntryAgent.value || pendingWorkspaceRoot.value)));
const hasStatusPopover = computed(() => hasSessionMeta.value || showExecutionPill.value);
const currentSessionId = ref(null);
const sessionFiles = ref([]);
const pendingAttachments = ref([]);
const sessionFilesLoading = ref(false);
const uploadingSessionFiles = ref(false);
const deletingSessionFileId = ref(null);
const sessionFileInputRef = ref(null);
const history = ref([]);
const pendingWorkspaceRoot = ref('');
const pendingEntryAgent = ref('');
const currentSessionTeam = ref('');
const entryAgentOptions = ref([]);
const entryAgentLoading = ref(false);
const messagesLoading = ref(false);
const historyLoading = ref(false);
const historyLoadingMore = ref(false);
const historyError = ref('');
const historyOffset = ref(0);
const historyHasMore = ref(true);
const chatInputRef = ref(null);
const llmSelectorRef = ref(null);
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
const ctxDrawerSelectedLlm = ref('');

function getCurrentSelectedLlm() {
  return llmSelectorRef.value?.getSelection() || props.selectedLLM || localStorage.getItem('selectedLLMModel') || '';
}

function openCtxDrawer() {
  ctxDrawerSelectedLlm.value = getCurrentSelectedLlm();
  ctxDrawerVisible.value = true;
}

const execDrawerVisible = ref(false);
const sessionFilesDrawerVisible = ref(false);
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
const editingAttachmentsDraft = ref([]);
const editingSubmitting = ref(false);
const sessionFilesDrawerTarget = ref('composer');
const sessionMetaExpanded = ref(false);
/** 展开查看详情的摘要消息 seq（持久化压缩：仅一条生效，用 seq 区分） */
const getChatSessionPath = (sessionId) => sessionId
  ? `/chat/${encodeURIComponent(sessionId)}`
  : '/';

const syncSessionFromRoute = async (sessionId) => {
  if (sessionId && sessionId !== currentSessionId.value) {
    clearExecutionState();
    currentSessionId.value = sessionId;
    const matched = history.value.find(item => item.session_id === sessionId);
    pendingWorkspaceRoot.value = matched?.metadata?.workspace_root || '';
    pendingEntryAgent.value = matched?.metadata?.entry_agent || '';
    currentSessionTeam.value = matched?.metadata?.team || '';
    pendingAttachments.value = [];
    await loadSessionMessages(sessionId);
    await loadSessionFiles(sessionId);
    return;
  }

  if (!sessionId && currentSessionId.value) {
    invalidateActiveStream();
    clearExecutionState();
    currentSessionId.value = null;
    sessionFiles.value = [];
    pendingWorkspaceRoot.value = '';
    pendingEntryAgent.value = '';
    loadActiveTeam();
    pendingAttachments.value = [];
    messages.value = [];
    sessionMetaExpanded.value = false;
  }
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

const invalidateActiveStream = () => {
  activeStreamToken.value += 1;
  if (currentStreamController.value) {
    currentStreamController.value.abort();
    currentStreamController.value = null;
  }
};

// 移动端状态

// 打开移动端侧边栏
const openMobileSidebar = () => {
  shellSidebarControl?.openMobileSidebar?.();
};

const loadEntryAgentOptions = async () => {
  entryAgentLoading.value = true;
  try {
    const configs = await getAllAgentConfigs();
    const items = Object.values(configs || {})
      .filter(config => config && config.enabled)
      .map(config => ({
        value: config.agent_name,
        label: config.display_name || config.agent_name,
        defaultEntry: Boolean(config.default_entry),
      }));
    entryAgentOptions.value = items;
  } catch (error) {
    console.warn('加载入口 Agent 列表失败:', error);
    entryAgentOptions.value = [];
  } finally {
    entryAgentLoading.value = false;
  }
};

const loadActiveTeam = async () => {
  try {
    const result = await getTeams();
    currentSessionTeam.value = result?.active_team || '';
  } catch (error) {
    console.warn('加载当前 Team 失败:', error);
  }
};

const handleGlobalPointerDown = (event) => {
  if (!sessionMetaExpanded.value) return;
  const container = sessionMetaContainerRef.value;
  if (container && !container.contains(event.target)) {
    sessionMetaExpanded.value = false;
  }
};

// 关闭移动端侧边栏
const closeMobileSidebar = () => {
  shellSidebarControl?.closeMobileSidebar?.();
};

// 触摸手势处理：touchstart
const handleTouchStart = () => {};

// 触摸手势处理：touchmove
const handleTouchMove = () => {};

// 触摸手势处理：touchend
const handleTouchEnd = () => {};

const startNewChat = () => {
  invalidateActiveStream();
  clearExecutionState();
  messages.value = [];
  inputMessage.value = '';
  pendingWorkspaceRoot.value = '';
  pendingEntryAgent.value = '';
  loadActiveTeam();
  pendingAttachments.value = [];
  sessionMetaExpanded.value = false;
  typewriterTimers.value.forEach(timer => clearTimeout(timer));
  typewriterTimers.value.clear();
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;
  currentSessionId.value = null;
  sessionFiles.value = [];
  router.replace('/');
  focusInput();
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

const updateScrollBottomGap = () => {
  if (!messagesRef.value) {
    scrollBottomGap.value = 0;
    return;
  }
  const container = messagesRef.value;
  scrollBottomGap.value = Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
};

const waitForScrollLayout = async () => {
  await nextTick();
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
};

const scrollToBottom = async (force = false, behavior = 'auto') => {
  await waitForScrollLayout();
  if (!messagesRef.value) return;
  if (force || shouldAutoScroll.value) {
    const container = messagesRef.value;
    _isProgrammaticScroll = true;
    if (behavior === 'smooth') {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth'
      });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    _lastScrollTop = container.scrollTop;
    updateScrollBottomGap();
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

  updateScrollBottomGap();

  if (_isProgrammaticScroll) {
    const atBottom = checkIfAtBottom();
    _lastScrollTop = container.scrollTop;
    _userScrollUpAccum = 0;
    isUserAtBottom.value = atBottom;
    shouldAutoScroll.value = atBottom;
    keepScrollButtonVisible.value = !atBottom;
    if (atBottom) {
      _isProgrammaticScroll = false;
    }
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
    keepScrollButtonVisible.value = !isUserAtBottom.value;
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
  keepScrollButtonVisible.value = true;
  _userScrollUpAccum = 0;
  scrollToBottom(true, 'smooth');
};

// execution.step 是执行树唯一事实源
const isRootEvent = (event) => !(event?.parent_call_id || event?.data?.parent_call_id);

const hasExecutionContent = (msg) => {
  if (!msg || msg.role !== 'assistant') return false;
  return Boolean(
    msg.has_execution
    || (Array.isArray(msg.subtasks) && msg.subtasks.length > 0)
    || (Array.isArray(msg.execution_steps) && msg.execution_steps.length > 0)
  );
};

const ensureExecutionProjector = (msg) => {
  if (!msg._executionProjector) {
    msg._executionProjector = createExecutionState();
  }
  return msg._executionProjector;
};

const syncExecutionProjection = (msg) => {
  const state = ensureExecutionProjector(msg);
  msg.subtasks = state.subtasks;
  msg.execution_steps = state.execution_steps;
  msg.has_execution = state.rawSteps.length > 0 || msg.has_execution;
  if (!msg.multimodalContents?.length || state.multimodalContents.length) {
    msg.multimodalContents = state.multimodalContents.slice();
  }
};

const ensureExecutionStepsLoaded = async (msg) => {
  if (!msg || !msg.id || !currentSessionId.value || msg.executionStepsLoaded || msg.executionStepsLoading || !msg.has_execution) {
    return;
  }
  msg.executionStepsLoading = true;
  msg.executionStepsLoadError = '';
  try {
    const payload = await getMessageRunSteps(currentSessionId.value, msg.id, { limit: 500, offset: 0 });
    const executionSteps = Array.isArray(payload?.items) ? payload.items : [];
    const projected = buildExecutionState(executionSteps);
    msg._executionProjector = projected;
    msg.subtasks = projected.subtasks;
    msg.execution_steps = projected.execution_steps;
    if (!msg.multimodalContents?.length || projected.multimodalContents.length) {
      msg.multimodalContents = projected.multimodalContents;
    }
    msg.executionStepsLoaded = true;
  } catch (error) {
    msg.executionStepsLoadError = error?.message || '加载执行过程失败';
    throw error;
  } finally {
    msg.executionStepsLoading = false;
  }
};

const toggleExecutionView = async (msg) => {
  if (!msg) return;
  if (msg.showFullSubtasks) {
    msg.showFullSubtasks = false;
    return;
  }
  if (msg.has_execution && !msg.executionStepsLoaded) {
    try {
      await ensureExecutionStepsLoaded(msg);
    } catch (_) {
      showToast(msg.executionStepsLoadError || '加载执行过程失败');
      return;
    }
  }
  msg.showFullSubtasks = true;
};

const createAssistantMessageFromHistory = (item) => {
  const interrupted = Boolean(item.metadata?.interrupted);
  return createAssistantMessage({
    id: item.id,
    seq: item.seq,
    content: interrupted ? '' : (item.content || ''),
    subtasks: [],
    execution_steps: [],
    multimodalContents: item.multimodalContents?.length > 0 ? item.multimodalContents : [],
    status: interrupted ? [{ type: 'error', content: '已中断' }] : (item.status || []),
    finished: true,
    stopped: interrupted,
    has_execution: Boolean(item.has_execution || item.metadata?.run_id),
    executionStepsLoaded: false,
    executionStepsLoading: false,
    executionStepsLoadError: '',
    run_id: item.metadata?.run_id || null,
    metadata: item.metadata || {},
    _executionProjector: null,
  });
};

const isMasterEvent = (event) => isRootEvent(event);

const findSubtaskByCallId = (subtasks, callId) => {
  if (!callId || !Array.isArray(subtasks)) return null;
  const stack = [...subtasks];
  while (stack.length > 0) {
    const subtask = stack.shift();
    if (!subtask) continue;
    if (subtask.task_id === callId) return subtask;
    if (Array.isArray(subtask.children) && subtask.children.length > 0) {
      stack.unshift(...subtask.children);
    }
  }
  return null;
};

const findRunningSubtaskByAgentName = (subtasks, agentName) => {
  if (!agentName || !Array.isArray(subtasks)) return null;
  const stack = [...subtasks];
  while (stack.length > 0) {
    const subtask = stack.shift();
    if (!subtask) continue;
    if (subtask.agent_name === agentName && subtask.status === 'running') return subtask;
    if (Array.isArray(subtask.children) && subtask.children.length > 0) {
      stack.unshift(...subtask.children);
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

const normalizeAttachment = (file) => {
  if (!file || typeof file !== 'object') return null;
  return {
    ...file,
    file_id: file.file_id || file.id,
    kind: String(file?.mime || '').startsWith('image/') ? 'image' : 'file',
  };
};

const isImageAttachment = (attachment) => String(attachment?.mime || '').startsWith('image/');

const formatAttachmentSize = (size) => {
  const num = Number(size || 0);
  if (!num) return '0 B';
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
};

const formatAttachmentMeta = (attachment) => {
  const parts = [formatAttachmentSize(attachment?.size)];
  if (attachment?.mime) parts.push(attachment.mime);
  return parts.join(' · ');
};

const getAttachmentPreviewUrl = (attachment) => {
  if (!currentSessionId.value || !attachment?.file_id) return '';
  return getSessionFileDownloadUrl(currentSessionId.value, attachment.file_id);
};

const removeAttachmentFromList = (list, attachment) => {
  const fileId = attachment?.file_id || attachment?.id;
  return list.filter(item => (item.file_id || item.id) !== fileId);
};

const currentDrawerPendingFiles = computed(() => (
  sessionFilesDrawerTarget.value === 'message-edit'
    ? editingAttachmentsDraft.value
    : pendingAttachments.value
));


const removePendingAttachment = (attachment) => {
  pendingAttachments.value = removeAttachmentFromList(pendingAttachments.value, attachment);
};

const removeEditingAttachment = (attachment) => {
  editingAttachmentsDraft.value = removeAttachmentFromList(editingAttachmentsDraft.value, attachment);
};

const reuseSessionFileAsAttachment = (file) => {
  const normalized = normalizeAttachment(file);
  if (!normalized) return;
  const targetList = sessionFilesDrawerTarget.value === 'message-edit'
    ? editingAttachmentsDraft.value
    : pendingAttachments.value;
  const fileId = normalized.file_id;
  if (!targetList.some(item => (item.file_id || item.id) === fileId)) {
    const nextList = [...targetList, normalized];
    if (sessionFilesDrawerTarget.value === 'message-edit') {
      editingAttachmentsDraft.value = nextList;
    } else {
      pendingAttachments.value = nextList;
    }
  }
  sessionFilesDrawerVisible.value = false;
  sessionFilesDrawerTarget.value = 'composer';
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
    const params = new URLSearchParams({
      limit: String(20),
      offset: String(historyOffset.value)
    });
    const response = await fetch(`/api/agent/sessions?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const payload = result.data || {};
    const items = payload.items || [];
    if (reset) {
      history.value = items;
      if (currentSessionId.value) {
        const matched = items.find(item => item.session_id === currentSessionId.value);
        if (matched) {
          pendingWorkspaceRoot.value = matched.metadata?.workspace_root || pendingWorkspaceRoot.value;
          pendingEntryAgent.value = matched.metadata?.entry_agent || pendingEntryAgent.value;
          currentSessionTeam.value = matched.metadata?.team || currentSessionTeam.value;
        }
      }
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
  messageCache.value.set(
    sessionId,
    list.slice(-500).map(item => normalizeAssistantExecutionState(item))
  );
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
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0&expand=none`);
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
        messages.value.push(createAssistantMessage());
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

const loadSessionFiles = async (sessionId) => {
  if (!sessionId) {
    sessionFiles.value = [];
    return;
  }
  sessionFilesLoading.value = true;
  try {
    const res = await listSessionFiles(sessionId);
    if (currentSessionId.value !== sessionId) return;
    sessionFiles.value = res.files || [];
  } catch (error) {
    showToast(error.message || '加载会话文件失败');
  } finally {
    sessionFilesLoading.value = false;
  }
};

const openSessionFilesDrawer = (target = 'composer') => {
  sessionFilesDrawerTarget.value = target;
  if (currentSessionId.value) {
    loadSessionFiles(currentSessionId.value);
  }
  sessionFilesDrawerVisible.value = true;
};

const triggerSessionFileInput = () => {
  sessionFileInputRef.value?.click();
};

const handleSessionFileSelect = async (filesOrEvent) => {
  const files = filesOrEvent?.target?.files || filesOrEvent;
  const normalizedFiles = Array.from(files || []).filter(file => file instanceof File);
  if (!normalizedFiles.length) return;
  const sessionId = await ensureSession();
  if (!sessionId) return;
  const fd = new FormData();
  for (const file of normalizedFiles) fd.append('files', file);
  uploadingSessionFiles.value = true;
  try {
    const res = await uploadSessionFiles(sessionId, fd);
    const createdFiles = (res.files || []).map(normalizeAttachment).filter(Boolean);
    const isEditingTarget = sessionFilesDrawerTarget.value === 'message-edit';
    const targetList = isEditingTarget ? editingAttachmentsDraft.value : pendingAttachments.value;
    const mergedFiles = [
      ...targetList,
      ...createdFiles.filter(file => !targetList.some(item => (item.file_id || item.id) === file.file_id))
    ];
    if (isEditingTarget) {
      editingAttachmentsDraft.value = mergedFiles;
    } else {
      pendingAttachments.value = mergedFiles;
    }
    showToast(`已添加 ${res.files?.length || 0} 个附件`, 'success');
    await loadSessionFiles(sessionId);
    sessionFilesDrawerVisible.value = true;
  } catch (error) {
    console.error('handleSessionFileSelect failed:', { sessionId, fileCount: normalizedFiles.length, error });
    showToast(error.message || '上传会话文件失败');
  } finally {
    uploadingSessionFiles.value = false;
    if (sessionFileInputRef.value) sessionFileInputRef.value.value = '';
  }
};

const downloadSessionFileItem = (file) => {
  if (!currentSessionId.value || !file?.id) return;
  window.open(getSessionFileDownloadUrl(currentSessionId.value, file.id), '_blank');
};

const removeSessionFile = async (file) => {
  if (!currentSessionId.value || !file?.id) return;
  deletingSessionFileId.value = file.id;
  try {
    await deleteSessionFile(currentSessionId.value, file.id);
    sessionFiles.value = sessionFiles.value.filter(item => item.id !== file.id);
    showToast('会话文件已删除', 'success');
  } catch (error) {
    showToast(error.message || '删除会话文件失败');
  } finally {
    deletingSessionFileId.value = null;
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
      messages.value = cached.map(item => normalizeAssistantExecutionState(item));
      messagesLoading.value = false;
      await nextTick();
      await scrollToBottom(true);
      await waitForScrollLayout();
      await scrollToBottom(true);
      focusInput();
      await loadContextSnapshot(sessionId);
      // 缓存命中也需检查是否有运行中任务
      await checkSessionTaskStatus(sessionId);
      return;
    }
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0&expand=none`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const items = result.data?.items || [];
    const mapped = items
      .filter(item => {
        const meta = item.metadata || {};
        // 隐藏 agent 专用消息（展开后的 prompt 等，visible_to_user=false 且非 display_only）
        if (meta.visible_to_user === false && !meta.display_only) return false;
        // 隐藏系统 meta 消息（中断标记等）
        if (meta.hidden) return false;
        return true;
      })
      .map(item => {
      if (item.role === 'assistant') {
        return createAssistantMessageFromHistory(item);
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
      const attachments = Array.isArray(item.metadata?.attachments)
        ? item.metadata.attachments.map(normalizeAttachment).filter(Boolean)
        : [];
      return { role: 'user', id: item.id, seq: item.seq, content: item.content || '', metadata: item.metadata || {}, attachments };
    });
    messages.value = mapped;
    cacheMessages(sessionId, mapped);
    messagesLoading.value = false;
    await nextTick();
    await scrollToBottom(true);
    await waitForScrollLayout();
    await scrollToBottom(true);
    focusInput();
    await loadContextSnapshot(sessionId);
    // ── 检查该会话是否有正在执行的任务 ──
    await checkSessionTaskStatus(sessionId);
  } catch (error) {
    console.error('loadSessionMessages failed:', { sessionId, error });
    showToast('加载会话失败', () => loadSessionMessages(sessionId));
  } finally {
    messagesLoading.value = false;
  }
};

const selectSession = async (item) => {
  if (!item?.session_id) return;
  if (currentSessionId.value === item.session_id) {
    messageCache.value.delete(item.session_id);
  }
  currentSessionId.value = item.session_id;
  pendingWorkspaceRoot.value = item.metadata?.workspace_root || '';
  pendingEntryAgent.value = item.metadata?.entry_agent || '';
  currentSessionTeam.value = item.metadata?.team || '';
  pendingAttachments.value = [];
  await router.push(getChatSessionPath(item.session_id));
  item.unread_count = 0;
  closeMobileSidebar();
  await loadSessionMessages(item.session_id);
  await loadSessionFiles(item.session_id);
};

const updateRecentSession = (sessionId, content, timestamp) => {
  if (!sessionId) return;
  const time = timestamp || new Date().toISOString();
  const normalizedContent = (content || '').toString();
  const summary = normalizedContent.slice(0, 30);
  const currentMetadata = currentSessionId.value === sessionId
    ? {
        ...(currentSessionTeam.value.trim() ? { team: currentSessionTeam.value.trim() } : {}),
        ...(pendingWorkspaceRoot.value.trim() ? { workspace_root: pendingWorkspaceRoot.value.trim() } : {}),
        ...(pendingEntryAgent.value.trim() ? { entry_agent: pendingEntryAgent.value.trim() } : {}),
      }
    : {};
  const nextItem = {
    session_id: sessionId,
    title: summary,
    first_message: summary,
    last_message: normalizedContent,
    last_message_at: time,
    unread_count: 0,
    metadata: currentMetadata,
  };
  const idx = history.value.findIndex(h => h.session_id === sessionId);
  if (idx >= 0) {
    const item = history.value[idx];
    Object.assign(item, nextItem, {
      title: summary || item.title || '',
      first_message: item.first_message || summary,
      metadata: { ...(item.metadata || {}), ...currentMetadata },
    });
    history.value.splice(idx, 1);
    history.value.unshift(item);
    props.onSessionUpdated?.(item);
  } else {
    history.value.unshift(nextItem);
    props.onSessionUpdated?.(nextItem);
  }
};

let _msgKeyCounter = 0;
const messageKey = (msg) => {
  if (msg._key == null) msg._key = `mk-${_msgKeyCounter++}`;
  return msg._key;
};

/** 用于展示的消息列表：
 *  1. 压缩摘要始终置顶（语义上它代表被压缩的早期对话）
 *  2. 仅保留 seq > replaces_up_to_seq 的后续消息 */
const visibleMessages = computed(() => {
  const list = messages.value;
  if (!list.length) return [];
  const withSeq = list.filter(m => m.seq != null);
  const summaryMsg = withSeq.filter(m => (m.metadata && m.metadata.compression) === true).sort((a, b) => (b.seq - a.seq))[0];
  if (!summaryMsg) return list;
  const replacesUpTo = summaryMsg.metadata?.replaces_up_to_seq;
  const cutoff = replacesUpTo != null ? replacesUpTo : summaryMsg.seq;
  const rest = list.filter(m =>
    m.seq == null
    || (m.metadata && m.metadata.compression) !== true && m.seq > cutoff
  );
  return [summaryMsg, ...rest];
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

const showExecutionPill = computed(() => {
  if (!currentSessionId.value) return false;
  if (isLoading.value) return true;
  if (sessionExecutionObservability.value?.task_id || sessionExecutionObservability.value?.run_id) return true;
  const status = sessionTaskInfo.value?.status;
  return status === 'running' || status === 'cancel_requested'
    || status === 'interrupted' || status === 'failed' || status === 'completed';
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

const COPY_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h5.5a2 2 0 0 1 2 2v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const COPIED_ICON_SVG = '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const markdownCopyFeedbackTimer = ref(null);

const copyTableAsText = (table) => {
  if (!table) return '';
  const rows = Array.from(table.querySelectorAll('tr'));
  return rows
    .map((row) => Array.from(row.querySelectorAll('th, td'))
      .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim())
      .join('\t'))
    .filter(Boolean)
    .join('\n');
};

const setMarkdownCopyFeedback = (button, copied) => {
  if (!(button instanceof HTMLElement)) return;
  if (markdownCopyFeedbackTimer.value) {
    clearTimeout(markdownCopyFeedbackTimer.value);
    markdownCopyFeedbackTimer.value = null;
  }

  button.dataset.copied = copied ? 'true' : 'false';
  const icon = button.querySelector('.md-block-copy-btn__icon');
  if (icon) {
    icon.innerHTML = copied ? COPIED_ICON_SVG : COPY_ICON_SVG;
  }

  if (copied) {
    markdownCopyFeedbackTimer.value = setTimeout(() => {
      button.dataset.copied = 'false';
      if (icon) icon.innerHTML = COPY_ICON_SVG;
      markdownCopyFeedbackTimer.value = null;
    }, 1600);
  }
};

const handleMarkdownBlockAction = async (event) => {
  const button = event.target instanceof Element
    ? event.target.closest('.md-block-copy-btn')
    : null;
  if (!button) return;

  const copyType = button.getAttribute('data-copy-type') || '';
  const rawPayload = button.getAttribute('data-copy-content') || '';
  let text = '';

  if (copyType === 'code') {
    try {
      text = decodeURIComponent(rawPayload);
    } catch {
      text = rawPayload;
    }
  } else if (copyType === 'table') {
    const block = button.closest('.md-table-block');
    const table = block?.querySelector('table');
    text = copyTableAsText(table);
  } else if (copyType === 'quote') {
    const block = button.closest('.md-quote-block');
    const quote = block?.querySelector('blockquote');
    text = (quote?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  if (!text) {
    setMarkdownCopyFeedback(button, false);
    showToast('无可复制内容');
    return;
  }

  const ok = await copyToClipboard(text);
  setMarkdownCopyFeedback(button, ok);
  showToast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'success' : 'error');
};

const startEditMessage = (msg, index) => {
  if (!msg || msg.role !== 'user') return;
  const idx = messages.value.findIndex(m => m === msg);
  editingMessageIndex.value = idx >= 0 ? idx : index;
  editingDraft.value = msg.content || '';
  editingAttachmentsDraft.value = Array.isArray(msg.attachments)
    ? msg.attachments.map(normalizeAttachment).filter(Boolean)
    : [];
  editingSubmitting.value = false;
  sessionFilesDrawerTarget.value = 'composer';

  console.log('[edit-debug] 开始编辑:', {
    msgId: msg.id,
    editingMessageIndex: editingMessageIndex.value,
    editingDraft: editingDraft.value?.substring(0, 50),
    attachmentsCount: editingAttachmentsDraft.value.length
  });

  nextTick(() => {
    const msgEl = document.querySelector(`.message[data-msg-index="${editingMessageIndex.value}"]`);
    const wrapperEl = msgEl?.querySelector('.message-content-wrapper');
    const previewWrap = msgEl?.querySelector('.user-bubble-preview-wrap');
    const editWrap = msgEl?.querySelector('.user-edit-detail-wrap');
    const editBox = msgEl?.querySelector('.msg-edit-box');

    console.log('[edit-debug] DOM 状态（立即）:', {
      msgEl: msgEl?.className,
      wrapperEl: {
        className: wrapperEl?.className,
        computedMaxWidth: wrapperEl ? getComputedStyle(wrapperEl).maxWidth : null,
        computedWidth: wrapperEl ? getComputedStyle(wrapperEl).width : null,
      },
      previewWrap: {
        className: previewWrap?.className,
        computedGridRows: previewWrap ? getComputedStyle(previewWrap).gridTemplateRows : null,
        computedOpacity: previewWrap ? getComputedStyle(previewWrap).opacity : null,
      },
      editWrap: {
        className: editWrap?.className,
        computedGridRows: editWrap ? getComputedStyle(editWrap).gridTemplateRows : null,
        computedOpacity: editWrap ? getComputedStyle(editWrap).opacity : null,
      },
      editBox: {
        exists: !!editBox,
        computedWidth: editBox ? getComputedStyle(editBox).width : null,
      }
    });

    // 等待动画完成后再检查
    setTimeout(() => {
      console.log('[edit-debug] DOM 状态（动画后 500ms）:', {
        wrapperEl: {
          computedMaxWidth: wrapperEl ? getComputedStyle(wrapperEl).maxWidth : null,
          computedWidth: wrapperEl ? getComputedStyle(wrapperEl).width : null,
        },
        previewWrap: {
          computedGridRows: previewWrap ? getComputedStyle(previewWrap).gridTemplateRows : null,
          computedOpacity: previewWrap ? getComputedStyle(previewWrap).opacity : null,
        },
        editWrap: {
          computedGridRows: editWrap ? getComputedStyle(editWrap).gridTemplateRows : null,
          computedOpacity: editWrap ? getComputedStyle(editWrap).opacity : null,
        },
        editBox: {
          computedWidth: editBox ? getComputedStyle(editBox).width : null,
        }
      });
    }, 500);
  });
};


const resetEditingState = ({ closeDrawer = true } = {}) => {
  editingMessageIndex.value = null;
  editingDraft.value = '';
  editingAttachmentsDraft.value = [];
  editingSubmitting.value = false;
  if (closeDrawer && sessionFilesDrawerTarget.value === 'message-edit') {
    sessionFilesDrawerVisible.value = false;
  }
  sessionFilesDrawerTarget.value = 'composer';
};

const cancelEdit = () => {
  if (editingSubmitting.value) return;
  resetEditingState();
};

/** 编辑后确定：先回退到该条之前，再以编辑后的内容流式发送（保持原有流式体验） */
const confirmEditAndResend = async () => {
  const idx = editingMessageIndex.value;
  if (idx == null || editingSubmitting.value) return;
  const msg = messages.value[idx];
  if (!msg || msg.role !== 'user') {
    cancelEdit();
    return;
  }
  const content = (editingDraft.value || '').trim();
  const attachments = editingAttachmentsDraft.value.slice();
  if (!content && !attachments.length) {
    showToast('内容和附件不能同时为空');
    return;
  }
  const sessionId = currentSessionId.value;
  if (!sessionId) { cancelEdit(); return; }
  editingSubmitting.value = true;
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
    await handleSend({ content, attachments, replaceFromIndex: idx, clearEditing: true });
  } catch (e) {
    editingSubmitting.value = false;
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
  const workspaceRoot = pendingWorkspaceRoot.value.trim();
  const entryAgent = pendingEntryAgent.value.trim();
  if (!currentSessionTeam.value.trim()) {
    await loadActiveTeam();
  }
  const team = currentSessionTeam.value.trim();
  const metadata = {
    ...(team ? { team } : {}),
    ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
    ...(entryAgent ? { entry_agent: entryAgent } : {}),
  };
  const body = {};
  if (userId) {
    body.user_id = userId;
  }
  if (Object.keys(metadata).length > 0) {
    body.metadata = metadata;
  }
  const response = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  const result = await response.json();
  currentSessionId.value = result.data?.session_id || null;
  if (currentSessionId.value) {
    const now = new Date().toISOString();
    const sessionMetadata = {
      ...(team ? { team } : {}),
      ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
      ...(entryAgent ? { entry_agent: entryAgent } : {}),
      ...(result.data?.metadata || {}),
    };
    props.onSessionCreated?.({
      session_id: currentSessionId.value,
      title: result.data?.title || 'New Conversation',
      first_message: '',
      last_message: '',
      last_message_at: result.data?.last_message_at || now,
      unread_count: 0,
      metadata: sessionMetadata,
    });
    pendingWorkspaceRoot.value = sessionMetadata.workspace_root || '';
    pendingEntryAgent.value = sessionMetadata.entry_agent || '';
    currentSessionTeam.value = sessionMetadata.team || '';
    await router.push(getChatSessionPath(currentSessionId.value));
    await loadSessionFiles(currentSessionId.value);
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
            else if (eventType === 'execution.step') {
              const projector = ensureExecutionProjector(currentMsg);
              applyStep(projector, eventData);
              syncExecutionProjection(currentMsg);
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
            else if (eventType === 'command.result') {
              const cmdData = eventData;
              const cmdMsg = messages.value[assistantMsgIndex];
              cmdMsg.role = 'system';
              cmdMsg.content = cmdData.content || '';
              cmdMsg.metadata = {
                type: 'command_result',
                command: cmdData.command || 'unknown',
                success: cmdData.success !== false,
                error: cmdData.error || null,
                data: cmdData.data || null,
              };
              cmdMsg.finished = true;
              nextTick(() => scrollToBottom(true));
            }
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
              if (isRootEvent(event)) {
                contextUsage.value = ctx;
              } else {
                // 写入对应 subtask
                const subtask = findRunningSubtaskByAgentName(currentMsg.subtasks, agentName);
                if (subtask) subtask.ctx = ctx;
              }
            }
            // 上下文压缩开始
            else if (eventType === 'context.compression_start') {
              isCompressing.value = true;
            }
            // 上下文压缩完成：将压缩摘要插入 messages 数组（去重，防止重连 replay 重复插入）
            else if (eventType === 'context.compression_summary') {
              isCompressing.value = false;
              const summaryContent = eventData.content || '';
              const alreadyExists = messages.value.some(
                m => m.metadata?.compression && m.content === summaryContent
              );
              if (!alreadyExists) {
                const compressionMsg = {
                  role: 'system',
                  content: summaryContent,
                  metadata: { compression: true },
                };
                messages.value.splice(assistantMsgIndex, 0, compressionMsg);
                assistantMsgIndex++;
              }
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

const handleSend = async (payload = null) => {
  let content = (payload?.content ?? inputMessage.value).trim();
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.slice() : pendingAttachments.value.slice();
  const replaceFromIndex = Number.isInteger(payload?.replaceFromIndex) ? payload.replaceFromIndex : null;
  const clearEditing = payload?.clearEditing === true;
  if ((!content && !attachments.length) || isLoading.value) return;

  const sessionId = await ensureSession();

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

  if (replaceFromIndex != null) {
    messages.value = messages.value.slice(0, replaceFromIndex);
    cacheMessages(sessionId, messages.value);
    if (clearEditing) {
      resetEditingState({ closeDrawer: false });
    }
  }

  inputSending.value = true;
  lastFailedSendContent.value = content;
  messages.value.push({ role: 'user', content: content, attachments: attachments, metadata: attachments.length ? { attachments } : {}, _justSent: true });
  inputMessage.value = '';
  pendingAttachments.value = [];
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;
  scrollToBottom(true);
  updateRecentSession(sessionId, content, new Date().toISOString());

  const justSentMessage = messages.value[messages.value.length - 1];
  window.setTimeout(() => {
    if (justSentMessage) delete justSentMessage._justSent;
    inputSending.value = false;
  }, 220);

  const assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;

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
      use_v2: true,
      attachments: attachments.map(({ file_id, original_name, stored_name, mime, size, kind }) => ({
        file_id,
        original_name,
        stored_name,
        mime,
        size,
        kind,
      })),
    };
    // 前端 llm-select-trigger 选择：临时指定默认主智能体及未配置 LLM 的智能体使用的模型（格式 provider|provider_type|model_name）
    const selectedLlm = getCurrentSelectedLlm();
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
      const currentMsg = messages.value[assistantMsgIndex];
      currentMsg.finished = true;
      currentMsg.stopped = true;
      currentMsg.metadata = { ...(currentMsg.metadata || {}), interrupted: true };
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
    scrollToBottom();
    if (activeStreamToken.value === streamToken) {
      currentStreamController.value = null;
    }
  }
};

watch(
  () => route.params.id || null,
  async (routeSessionId) => {
    const nextSessionId = typeof routeSessionId === 'string' ? decodeURIComponent(routeSessionId) : null;
    await syncSessionFromRoute(nextSessionId);
  },
  { immediate: true }
);

onMounted(() => {
  isUserAtBottom.value = true;
  shouldAutoScroll.value = true;
  _userScrollUpAccum = 0;

  updateScrollBottomGap();
  scrollToBottom(true);
  loadEntryAgentOptions();
  loadActiveTeam();
  loadRecentSessions(true);
  window.addEventListener('pointerdown', handleGlobalPointerDown);
});

onUnmounted(() => {
  stopRetryTicker();

  // 不再通知后端停止任务 — Agent 继续在后台执行

  invalidateActiveStream();
  window.removeEventListener('pointerdown', handleGlobalPointerDown);
});
</script>

<style scoped src="../styles/chat-view.css"></style>
<style scoped>
/* #9: 压缩摘要 - 已移除独立卡片样式，走通用 assistant 渲染路径 */
.user-edit-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transform-origin: top right;
  transition: opacity 220ms ease, transform 220ms ease, filter 220ms ease;
  will-change: transform, opacity;
}
.user-edit-shell.is-editing {
  transform: translateY(-1px);
}
.user-edit-shell.is-submitting {
  opacity: 0.86;
  filter: saturate(0.96);
  transform: translateY(-1px);
}
.user-text {
  transition:
    background-color var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    border-color var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    box-shadow var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    min-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    max-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    filter var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1));
  will-change: transform, opacity, min-height, max-height;
}
.user-text.is-editing {
  transform: none;
}
.user-text.is-submitting {
  opacity: 1;
  filter: none;
  transform: none;
}
.user-attachments {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 0;
  transition: opacity 220ms ease, transform 220ms ease, filter 220ms ease;
  will-change: transform, opacity;
}
.user-attachments.is-editing {
  align-items: flex-end;
  margin-bottom: 0;
}
.user-attachments.is-submitting {
  opacity: 1;
  filter: none;
  transform: none;
}
.user-attachments-toolbar {
  display: flex;
  justify-content: flex-end;
  width: min(420px, 100%);
  box-sizing: border-box;
  margin-top: 2px;
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  transform: translateY(-4px);
  pointer-events: none;
  transition: opacity var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)), max-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)), transform var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1));
}
.user-attachments-toolbar.is-visible {
  opacity: 1;
  max-height: 40px;
  transform: translateY(0);
  pointer-events: auto;
}
.user-attachment-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(420px, 100%);
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  transition: transform 220ms ease, box-shadow 220ms ease, border-color 220ms ease, opacity 220ms ease, filter 220ms ease;
}
.user-attachment-card:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
}
.btn-editor {
  transition: transform 180ms ease, opacity 180ms ease, box-shadow 180ms ease, filter 180ms ease;
}
.btn-editor:hover:not(:disabled) {
  transform: translateY(-1px);
}
.btn-editor:active:not(:disabled) {
  transform: scale(0.985);
}
.btn-editor:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.user-attachment-image {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}
.user-attachment-file-icon {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.user-attachment-info {
  min-width: 0;
  flex: 1;
}
.user-attachment-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-attachment-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 优化后的 workspace-root-input-row 样式 */
.workspace-root-input-row {
  width: 100%;
  max-width: 800px;
  margin: 0 auto 6px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.workspace-root-input-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: 500;
  min-width: 72px;
  flex-shrink: 0;
}

.workspace-root-input {
  flex: 1;
  padding: 8px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-family: var(--font-sans);
  transition: all 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.workspace-root-input::placeholder {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.workspace-root-input:hover {
  border-color: var(--color-border-hover);
}

.workspace-root-input:focus {
  outline: none;
  border-color: rgba(var(--color-brand-accent-rgb), 0.5);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.08);
}

.session-meta-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-meta-section + .session-meta-section {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.session-meta-section-title {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: 600;
}

.session-meta-popover-anchor {
  position: relative;
  flex-shrink: 0;
  z-index: calc(var(--z-sticky, 10) + 4);
}

.session-meta-popover-anchor--inline-end {
  margin-left: auto;
}

.execution-pill--popover {
  width: 20px;
  height: 20px;
  margin-left: 0;
  color: var(--color-text-muted);
}

.execution-pill--popover:hover,
.execution-pill--popover.is-expanded {
  color: var(--color-text-primary);
  opacity: 1;
}

.execution-pill__icon {
  width: 14px;
  height: 14px;
}

.session-meta-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.session-meta-toggle--icon {
  width: 18px;
  height: 18px;
  padding: 0;
  justify-content: center;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.session-meta-toggle-arrow {
  font-size: 11px;
  color: var(--color-text-muted);
}

.session-meta-toggle:hover,
.session-meta-toggle.is-expanded {
  color: var(--color-text-primary);
  border-color: var(--color-border-hover);
  background: var(--color-bg-tertiary);
}

.session-meta-panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 14px);
  z-index: 120;
  min-width: 260px;
  max-width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
}

.session-meta-panel--end {
  left: auto;
  right: 0;
  transform: translateY(-2px);
}

.session-meta-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.session-meta-label {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.session-meta-value {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.session-meta-value--path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  flex-wrap: nowrap;
}

.execution-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.2s ease, color 0.2s ease;
}

.execution-pill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
  opacity: 0.9;
}

.execution-pill--popover::before {
  display: none;
}

.execution-pill.is-running {
  color: var(--color-brand-accent-light);
}

.execution-pill.is-running::before {
  animation: execution-pill-breathe 1.8s ease-in-out infinite;
}

.execution-pill.is-warning {
  color: var(--color-warning);
}

.execution-pill.is-warning::before {
  animation: execution-pill-breathe 1.6s ease-in-out infinite;
}

.execution-pill.is-error {
  color: var(--color-error);
}

.execution-pill.is-error::before {
  animation: execution-pill-breathe 1.35s ease-in-out infinite;
}

.execution-pill.is-success {
  color: var(--color-success);
}

@keyframes execution-pill-breathe {
  0%, 100% {
    opacity: 0.45;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}
/* .context-usage-bar:hover {
  background: var(--color-bg-secondary);
} */

.context-usage-content {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  cursor: pointer;
  padding: 4px;
  margin: -4px;
}

.context-usage-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  .composer-status-row {
    align-items: center;
  }

  .execution-pill {
    margin-left: 0;
  }
}

@media (max-width: 480px) {
  .context-usage-content {
    flex: 0 0 auto;
  }

  .context-usage-label,
  .compressing-indicator {
    display: none;
  }
}

/* ===== Scroll to Bottom Button ===== */
.scroll-to-bottom-btn {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 12px);
  right: auto;
  transform: translateX(-50%);
  z-index: 1;
  color: var(--color-text-primary);
  cursor: pointer;
  pointer-events: auto;
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.scroll-to-bottom-btn:hover {
  transform: translateX(-50%) translateY(-2px);
}

.scroll-to-bottom-btn:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 3px;
}

.scroll-btn-fade-enter-active,
.scroll-btn-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.scroll-btn-fade-enter-from,
.scroll-btn-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px) scale(0.92);
}

@media (max-width: 767px) {
  .scroll-to-bottom-btn {
    bottom: calc(100% + 10px);
    z-index: 1;
  }
}
/* 顶部右侧会话文件/导出按钮：桌面端保留文字，移动端收敛为与主题按钮一致的图标态 */
.top-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.top-action-btn svg {
  flex-shrink: 0;
}

.top-action-btn:disabled {
  opacity: 0.5;
}

@media (max-width: 767px) {
  .top-action-btn {
    width: 44px;
    min-width: 44px;
    height: 44px;
    padding: 0;
    /* border-radius: 12px; */
    justify-content: center;
    gap: 0;
  }

  .top-action-btn svg {
    width: 20px;
    height: 20px;
  }
}

.stopped-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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

/* 消息查看/编辑模式切换动画 */
.message-view-mode,
.message-edit-mode {
  animation: messageSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

</style>
