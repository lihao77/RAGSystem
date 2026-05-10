<template>
  <div class="chat-page-shell">
    <main class="chat-main" :class="{ 'has-messages': messages.length > 0, 'workbench-layout': showWorkPanel }">
    <div class="chat-conversation-column">
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
            <div v-for="(msg, index) in visibleMessages" :key="messageKey(msg)" :class="['message', msg.role]" :data-msg-index="index"
              @mouseenter="messageActionsVisible = index" @mouseleave="messageActionsVisible = null">
              <!-- 斜杠命令结果 -->
              <div v-if="msg.role === 'system' && msg.metadata?.type === 'command_result'" class="message-content-wrapper">
                <CommandResultMessage :message="msg" />
              </div>
              <!-- Subtasks Container - 占满整个 message 宽度（桌面双栏时隐藏，执行信息移至工作栏）-->
              <div v-else-if="!showWorkPanel && msg.role === 'assistant' && (hasExecutionContent(msg) || !msg.finished)"
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
                    <div class="loading-dots" aria-hidden="true">
                      <div class="dot"></div>
                      <div class="dot"></div>
                      <div class="dot"></div>
                    </div>
                    <span class="loading-text">{{ getAssistantRuntimeStatusText(msg) || '正在运行...' }}</span>
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
                    <!-- Task Notification Block -->
                    <div v-if="msg.metadata?.source === 'system.bg_notification'" class="task-notification-block">
                      <div class="task-notification-header">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                        <span>Background Task Notification</span>
                      </div>
                      <div class="task-notification-body">
                        <div v-for="item in parseTaskNotifications(msg)" :key="item.taskId" class="task-notification-item">
                          <span class="tn-status" :class="item.status">{{ item.status }}</span>
                          <code class="tn-task-id">{{ item.taskId.slice(0, 8) }}</code>
                          <span v-if="item.resultType" class="tn-type">{{ item.resultType }}</span>
                        </div>
                      </div>
                    </div>
                    <!-- 非编辑态：气泡 -->
                    <div v-else-if="editingMessage !== msg" class="user-bubble-wrapper message-view-mode">
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
                  <button
                    v-if="showWorkPanel && hasExecutionContent(msg)"
                    type="button"
                    class="msg-action-btn btn-execution-tree"
                    :class="{ active: selectedWorkPanelMessageKey === getWorkPanelMessageKey(msg) }"
                    title="在工作栏查看执行树"
                    @click="selectWorkPanelMessage(msg)"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 3v12"></path>
                      <circle cx="6" cy="18" r="3"></circle>
                      <path d="M6 9h8"></path>
                      <circle cx="17" cy="9" r="3"></circle>
                    </svg>
                  </button>
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
                  <span
                    v-if="getMessageExecutionTimeText(msg)"
                    class="message-execution-time"
                    :title="getMessageExecutionTimeTitle(msg)"
                  >
                    {{ getMessageExecutionTimeText(msg) }}
                  </span>
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
          <div class="input-area-wrapper">
          <div v-if="!currentSessionId" class="workspace-root-input-row">
            <label class="workspace-root-input-label">入口 Agent</label>
            <CustomSelect
              v-model="pendingEntryAgent"
              :options="entryAgentOptions"
              :disabled="entryAgentLoading"
              :dropdown-max-height="320"
              dropdown-placement="auto"
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
              @blur="pendingWorkspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot)"
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
            @pasteFiles="handleSessionFileSelect"
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
    </div><!-- end .chat-conversation-column -->
    <WorkPanel
      v-if="showWorkPanel"
      :active-run="_activeRun"
      :current-message="currentRunMessage"
      :approval-queue="approvalQueue"
      :approval-submitting-id="approvalSubmittingId"
      :pending-user-input="pendingUserInput"
      :context-usage="contextUsage"
      :session-id="currentSessionId || ''"
      :message-key="currentRunMessageKey"
      @approval-submit="({ approvalId, approved, message }) => submitApproval(approvalId, approved, message, currentSessionId)"
      @user-input-submit="handleWorkPanelUserInputSubmit"
      @user-input-cancel="handleWorkPanelUserInputCancel"
    />
    </main>
    <AppToast ref="toastRef" />

    <!-- 上下文快照抽屉 -->
    <ContextSnapshotDrawer
      :visible="ctxDrawerVisible"
      :session-id="currentSessionId"
      :selected-llm="ctxDrawerSelectedLlm"
      @close="ctxDrawerVisible = false"
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
import { ref, reactive, computed, nextTick, onMounted, onUnmounted, watch, inject } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { renderMarkdown } from '../utils/markdown';
import { buildExecutionState, createExecutionState, applyStep } from '../utils/executionProjector';
import { shouldRefreshSessionMessagesAfterResume, shouldRunResumeRecoveryWatchdog } from '../utils/sessionSocket';
import { useSessionConnection } from '../composables/useSessionConnection';
import { useSessionTaskStatus } from '../composables/useSessionTaskStatus';
import { useSessionMessages } from '../composables/useSessionMessages';
import { useSessionRunStream } from '../composables/useSessionRunStream';
import { useMessageRevision } from '../composables/useMessageRevision';
import { useSessionFilesAttachments } from '../composables/useSessionFilesAttachments';
import { usePointerDownOutside } from '../composables/usePointerDownOutside';
import { normalizeSessionAttachment as normalizeAttachmentUtil } from '../utils/sessionAttachments';
import SubtaskStatusTicker from '../components/SubtaskStatusTicker.vue';
import HierarchicalExecutionTree from '../components/HierarchicalExecutionTree.vue';
import UserInputDialog from '../components/UserInputDialog.vue';
import ChatInput from '../components/ChatInput.vue';
import ChartRenderer from '../components/ChartRenderer.vue';
import MapRenderer from '../components/MapRenderer.vue';
import VisualizationLoader from '../components/VisualizationLoader.vue';
import SessionFilesDrawer from '../components/SessionFilesDrawer.vue';
import SituationScreen from '../components/SituationScreen.vue';
import LLMSelector from '../components/LLMSelector.vue';
import CustomSelect from '../components/CustomSelect.vue';
import MessageEditBox from '../components/MessageEditBox.vue';
import PermissionModeSelector from '../components/PermissionModeSelector.vue';
import { getAllAgentConfigs, getTeams } from '../api/agentConfig';

// 审批 ack 超时计时器（模块级 Map，替代 window 全局）
const _approvalAckTimers = new Map();

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
  metadata: {},
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
import ApprovalDialog from '../components/ApprovalDialog.vue';
import FilePreviewConfirmDialog from '../components/FilePreviewConfirmDialog.vue';
import ContextSnapshotDrawer from '../components/ContextSnapshotDrawer.vue';
import AppToast from '../components/AppToast.vue';
import { IconLogo, IconMenu } from '../components/icons';
import { getMessageRunSteps } from '../api/monitoring';
import CommandResultMessage from '../components/CommandResultMessage.vue';
import WorkPanel from '../components/workpanel/WorkPanel.vue';
import { useWorkbenchLayout } from '../composables/useWorkbenchLayout';

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

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const topControlsBarRef = ref(null);
const sessionMetaContainerRef = ref(null);
// 跟随状态：true 时自动滚动到底部，用户上滚超过阈值脱离，滚回底部恢复
const isFollowing = ref(true);
const scrollBottomGap = ref(0);
const showScrollToBottomButton = computed(() => {
  if (!messages.value.length) return false;
  return !isFollowing.value;
});

const hasSessionMeta = computed(() => Boolean(currentSessionId.value && (currentSessionTeam.value || pendingEntryAgent.value || pendingWorkspaceRoot.value)));
const hasStatusPopover = computed(() => hasSessionMeta.value || showExecutionPill.value);
const currentSessionId = ref(null);
const sessionFilesDrawerVisible = ref(false);
const sessionFilesDrawerTarget = ref('composer');
const history = ref([]);
const pendingWorkspaceRoot = ref('');
const pendingEntryAgent = ref('');
const currentSessionTeam = ref('');
const entryAgentOptions = ref([]);
const entryAgentLoading = ref(false);

const stripWrappedQuotes = (value) => {
  const trimmed = (value || '').trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const normalizeWorkspaceRootInput = (value) => stripWrappedQuotes(value);
const historyLoading = ref(false);
const historyLoadingMore = ref(false);
const historyError = ref('');
const historyOffset = ref(0);
const historyHasMore = ref(true);
const chatInputRef = ref(null);
const llmSelectorRef = ref(null);
const approvalDialogRef = ref(null);
const filePreviewDialogRef = ref(null);
const userInputDialogRef = ref(null);
const toastRef = ref(null);
const isExportingSession = ref(false);
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

const llmRetryState = ref(null);
const retryClockMs = ref(Date.now());
let llmRetryTimer = null;
const lastFailedSendContent = ref('');
const approvalQueue = ref([]);
const approvalSubmittingId = ref('');
const pendingUserInput = ref(null); // { data, submit, cancel } — 双栏内联用户输入

const handleWorkPanelUserInputSubmit = async ({ inputId, value } = {}) => {
  const pending = pendingUserInput.value;
  if (!pending?.submit) return;
  pendingUserInput.value = null;
  await pending.submit(inputId, value);
};

const handleWorkPanelUserInputCancel = async () => {
  const pending = pendingUserInput.value;
  if (!pending?.cancel) {
    pendingUserInput.value = null;
    return;
  }
  pendingUserInput.value = null;
  await pending.cancel();
};

// ── 当前活跃 run 的状态（WS 事件处理用，共享给 composables） ──
const _activeRun = reactive({
  active: false,
  assistantMsgIndex: -1,
  runId: null,
  lastSeenSeq: 0,
  isReplaying: false,
  phase: 'idle',
  runStartedAt: null,
  firstTokenAt: null,
  firstTokenLatencyMs: null,
  latestLlmFirstTokenAt: null,
  lastChunkAt: null,
  waiting: null,
  outputCharCount: 0,
});

// ── Composables ─────────────────────────────────────────────────────────
// 注意：deps 中的函数通过闭包引用，在调用时（非初始化时）解析，
// 因此可以安全引用后续定义的函数（scrollToBottom, showToast 等）。

const {
  messagesLoading, cacheMessages, deleteMessageCache,
  loadSessionMessages, mergeMessageIdsFromServer,
} = useSessionMessages({
  currentSessionId, messages,
  normalizeAssistantExecutionState,
  createAssistantMessageFromHistory: (...a) => createAssistantMessageFromHistory(...a),
  normalizeAttachment: (...a) => normalizeAttachmentUtil(...a),
  scrollToBottom: (...a) => scrollToBottom(...a),
  waitForScrollLayout: () => waitForScrollLayout(),
  focusInput: () => focusInput(),
  loadContextSnapshot: (...a) => loadContextSnapshot(...a),
  showToast: (...a) => showToast(...a),
  invalidateActiveStream: () => invalidateActiveStream(),
});

const {
  sessionTaskInfo, sessionExecutionObservability, contextUsage,
  mergeExecutionObservability,
  loadContextSnapshot, refreshSessionExecutionState,
  checkSessionTaskStatus, clearExecutionState: _clearExecutionStateBase, beginOptimisticExecutionState,
} = useSessionTaskStatus({
  currentSessionId, messages, isLoading,
  shouldRefreshFn: shouldRefreshSessionMessagesAfterResume,
  shouldRunWatchdogFn: shouldRunResumeRecoveryWatchdog,
  getActiveRun: () => _activeRun,
  invalidateActiveStream: () => invalidateActiveStream(),
  loadSessionMessages,
  deleteMessageCache,
  createAssistantMessage,
  scheduleCommandFallback: (...a) => scheduleCommandFallback(...a),
  scheduleResumeRecovery: (...a) => scheduleSessionResumeRecovery(...a),
  clearLlmRetryState: () => clearLlmRetryState(),
});

const { showWorkPanel } = useWorkbenchLayout();
const selectedWorkPanelMessageKey = ref('');
const getWorkPanelMessageKey = (msg) => {
  if (!msg) return '';
  if (msg.id) return `id:${msg.id}`;
  if (msg.seq != null) return `seq:${msg.seq}`;
  return `idx:${messages.value.indexOf(msg)}`;
};
const workPanelExecutionMessages = computed(() => messages.value
  .map((msg, index) => ({ msg, index }))
  .filter(({ msg }) => hasExecutionContent(msg))
  .map(({ msg, index }) => ({
    key: getWorkPanelMessageKey(msg),
    index,
    message: msg,
  })));

const activeWorkPanelRunMessage = computed(() => {
  if (_activeRun.assistantMsgIndex < 0) return null;
  return messages.value[_activeRun.assistantMsgIndex] ?? null;
});
const activeWorkPanelRunMessageKey = computed(() => getWorkPanelMessageKey(activeWorkPanelRunMessage.value));

const currentRunMessage = computed(() => {
  if (_activeRun.active) {
    return activeWorkPanelRunMessage.value;
  }
  const selected = workPanelExecutionMessages.value.find(item => item.key === selectedWorkPanelMessageKey.value)?.message;
  if (selected) return selected;
  return workPanelExecutionMessages.value.at(-1)?.message || null;
});
const currentRunMessageKey = computed(() => getWorkPanelMessageKey(currentRunMessage.value));

watch(currentRunMessage, (msg) => {
  if (!_activeRun.active && msg?.has_execution && !msg.executionStepsLoaded) {
    ensureExecutionStepsLoaded(msg).catch(() => {
      showToast(msg.executionStepsLoadError || '加载执行过程失败');
    });
  }
});

watch(workPanelExecutionMessages, (items) => {
  if (_activeRun.active) return;
  const latestKey = items.at(-1)?.key || '';
  const activeRunKey = activeWorkPanelRunMessageKey.value;
  if (activeRunKey && items.some(item => item.key === activeRunKey)) {
    selectedWorkPanelMessageKey.value = activeRunKey;
    return;
  }
  if (selectedWorkPanelMessageKey.value && items.some(item => item.key === selectedWorkPanelMessageKey.value)) {
    return;
  }
  selectedWorkPanelMessageKey.value = latestKey;
}, { immediate: true });

watch(() => _activeRun.active, (active, wasActive) => {
  const activeRunKey = activeWorkPanelRunMessageKey.value;
  if (activeRunKey && workPanelExecutionMessages.value.some(item => item.key === activeRunKey)) {
    selectedWorkPanelMessageKey.value = activeRunKey;
    return;
  }
  if (wasActive && !active) {
    selectedWorkPanelMessageKey.value = workPanelExecutionMessages.value.at(-1)?.key || '';
  }
});

async function selectWorkPanelMessage(msgOrKey) {
  const key = typeof msgOrKey === 'string' ? msgOrKey : getWorkPanelMessageKey(msgOrKey);
  selectedWorkPanelMessageKey.value = key || '';
  const msg = typeof msgOrKey === 'string'
    ? workPanelExecutionMessages.value.find(item => item.key === key)?.message
    : msgOrKey;
  if (msg?.has_execution && !msg.executionStepsLoaded) {
    try {
      await ensureExecutionStepsLoaded(msg);
    } catch (_) {
      showToast(msg.executionStepsLoadError || '加载执行过程失败');
    }
  }
}

const {
  invalidateActiveStream, scheduleCommandFallback, clearCommandFallback,
  clearSessionResumeRecovery, scheduleSessionResumeRecovery,
  connectSessionWS, disconnectSessionWS, getWS,
} = useSessionConnection({
  currentSessionId, messages, isLoading, isCompressing,
  activeRun: _activeRun,
  onMessage: (...a) => handleWSMessage(...a),
  onRunFinalized: (sid) => _finalizeActiveRun(sid),
  resetApprovalState: () => resetApprovalState(),
  loadSessionMessages,
  deleteMessageCache,
  clearLlmRetryState: () => clearLlmRetryState(),
  cacheMessages,
  refreshSessionExecutionState,
  scrollToBottom: (...a) => scrollToBottom(...a),
});
const {
  sessionFiles,
  pendingAttachments,
  sessionFilesLoading,
  uploadingSessionFiles,
  deletingSessionFileId,
  normalizeAttachment,
  isImageAttachment,
  formatAttachmentMeta,
  getAttachmentPreviewUrl,
  currentDrawerPendingFiles,
  removePendingAttachment,
  removeEditingAttachment,
  reuseSessionFileAsAttachment,
  loadSessionFiles,
  openSessionFilesDrawer,
  handleSessionFileSelect,
  materializeAttachmentsForSend,
  clearComposerAttachments,
  clearEditingAttachments,
  downloadSessionFileItem,
  removeSessionFile,
} = useSessionFilesAttachments({
  currentSessionId,
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  getEditingAttachmentsDraft: () => editingAttachmentsDraft.value,
  setEditingAttachmentsDraft: (value) => { editingAttachmentsDraft.value = value; },
  ensureSession: (...a) => ensureSession(...a),
  showToast: (...a) => showToast(...a),
});

const {
  editingMessage,
  editingDraft,
  editingAttachmentsDraft,
  editingSubmitting,
  startEditMessage,
  resetEditingState,
  cancelEdit,
  confirmEditAndResend,
  rollbackAndRetry,
} = useMessageRevision({
  messages,
  currentSessionId,
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  normalizeAttachment,
  showToast: (...a) => showToast(...a),
  cacheMessages,
  inputMessage,
  handleSend: (...a) => handleSend(...a),
});

const {
  handleWSMessage,
  finalizeActiveRun: _finalizeActiveRun,
} = useSessionRunStream({
  currentSessionId,
  messages,
  isLoading,
  isCompressing,
  contextUsage,
  sessionTaskInfo,
  activeRun: _activeRun,
  llmRetryState,
  userInputDialogRef,
  showUserInput: (eventData, submitFn, cancelFn) => {
    if (showWorkPanel.value) {
      // 双栏模式：存入工作栏内联
      pendingUserInput.value = { data: eventData, submit: submitFn, cancel: cancelFn };
    } else {
      userInputDialogRef.value?.show(eventData, submitFn, cancelFn);
    }
  },
  getWS,
  createAssistantMessage,
  clearSessionResumeRecovery,
  clearCommandFallback,
  scheduleCommandFallback,
  deleteMessageCache,
  loadSessionMessages,
  mergeMessageIdsFromServer,
  refreshSessionExecutionState,
  mergeExecutionObservability,
  cacheMessages,
  clearLlmRetryState: (...a) => clearLlmRetryState(...a),
  scrollToBottom: (...a) => scrollToBottom(...a),
  showToast: (...a) => showToast(...a),
  setLlmRetryState: (...a) => setLlmRetryState(...a),
  updateRecentSession: (...a) => updateRecentSession(...a),
  checkSituationScreenTrigger: (...a) => checkSituationScreenTrigger(...a),
  ensureExecutionProjector: (...a) => ensureExecutionProjector(...a),
  syncExecutionProjection: (...a) => syncExecutionProjection(...a),
  findSubtaskByCallId: (...a) => findSubtaskByCallId(...a),
  findRunningSubtaskByAgentName: (...a) => findRunningSubtaskByAgentName(...a),
  enqueueApproval: (...a) => enqueueApproval(...a),
  handleApprovalResolved: (...a) => handleApprovalResolved(...a),
  buildTaskNotificationMessage: (...a) => buildTaskNotificationMessage(...a),
  isRootEvent: (...a) => isRootEvent(...a),
  isMasterEvent: (...a) => isMasterEvent(...a),
  applyStep,
  handleStop: (...a) => handleStop(...a),
});

// clearExecutionState 需要额外清理 view 级状态
const clearExecutionState = () => {
  _clearExecutionStateBase();
};
// ── end Composables ─────────────────────────────────────────────────────

// ── 态势大屏状态 ──────────────────────────────────────────
const situationScreenActive = ref(false);
const situationArtifactId = ref(null);
const situationMapData = ref(null);
const situationInfo = ref(null);
const messageActionsVisible = ref(null);
const sessionMetaExpanded = ref(false);
/** 展开查看详情的摘要消息 seq（持久化压缩：仅一条生效，用 seq 区分） */
const getChatSessionPath = (sessionId) => sessionId
  ? `/chat/${encodeURIComponent(sessionId)}`
  : '/';

const syncSessionFromRoute = async (sessionId) => {
  if (sessionId && sessionId !== currentSessionId.value) {
    disconnectSessionWS();
    invalidateActiveStream();
    clearExecutionState();
    isLoading.value = false;
    currentSessionId.value = sessionId;
    const matched = history.value.find(item => item.session_id === sessionId);
    pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(matched?.metadata?.workspace_root || '');
    pendingEntryAgent.value = matched?.metadata?.entry_agent || '';
    currentSessionTeam.value = matched?.metadata?.team || '';
    clearComposerAttachments();
    await loadSessionMessages(sessionId);
    await loadSessionFiles(sessionId);
    connectSessionWS(sessionId);
    // 消息加载完成后独立检查任务状态（不在 loadSessionMessages 内部调用）
    await checkSessionTaskStatus(sessionId);
    return;
  }

  if (!sessionId && currentSessionId.value) {
    disconnectSessionWS();
    invalidateActiveStream();
    clearExecutionState();
    isLoading.value = false;
    currentSessionId.value = null;
    sessionFiles.value = [];
    pendingWorkspaceRoot.value = '';
    pendingEntryAgent.value = '';
    loadActiveTeam();
    clearComposerAttachments();
    messages.value = [];
    sessionFilesDrawerVisible.value = false;
    sessionFilesDrawerTarget.value = 'composer';
    sessionMetaExpanded.value = false;
  }
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

const normalizeApprovalEventData = (event, eventData) => ({
  ...eventData,
  approval_id: eventData?.approval_id || '',
  agent_name: event?.agent_name || eventData?.agent_name || '智能体',
});

const getApprovalDialogRef = (approval) => {
  if (!approval) return null;
  return approval.approval_type === 'file_read_confirm'
    ? filePreviewDialogRef.value
    : approvalDialogRef.value;
};

const hideApprovalDialogs = () => {
  approvalDialogRef.value?.hide?.();
  filePreviewDialogRef.value?.hide?.();
};

const removeApprovalFromQueue = (approvalId) => {
  if (!approvalId) return;
  approvalQueue.value = approvalQueue.value.filter(item => item?.approval_id !== approvalId);
};

// 统一审批提交逻辑（WS 优先，降级 HTTP），供对话框和工作栏内联共用
const submitApproval = async (aid, approved, message, sessionId) => {
  if (!aid || approvalSubmittingId.value) return;
  approvalSubmittingId.value = aid;
  const sid = sessionId || currentSessionId.value;
  if (getWS()?.readyState === WebSocket.OPEN) {
    getWS().send(JSON.stringify({ type: 'approve', approval_id: aid, approved, message }));
    const ackTimer = setTimeout(async () => {
      if (approvalSubmittingId.value !== aid) return;
      console.warn(`[Approval] WS ack 超时 (${aid})，降级 HTTP 重试`);
      try {
        const resp = await fetch(
          `/api/agent/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(aid)}/respond`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved, message }) }
        );
        if (!resp.ok) throw new Error(`HTTP fallback 失败 (${resp.status})`);
        handleApprovalResolved(aid, sid);
      } catch (e) {
        removeApprovalFromQueue(aid);
        approvalSubmittingId.value = '';
        showToast(e.message || '审批提交超时', 'warning');
        hideApprovalDialogs();
        showNextApproval(sid);
      }
    }, 5000);
    _approvalAckTimers.set(aid, ackTimer);
    return;
  }
  try {
    const resp = await fetch(
      `/api/agent/sessions/${encodeURIComponent(sid)}/approvals/${encodeURIComponent(aid)}/respond`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved, message }) }
    );
    if (!resp.ok) {
      const result = await resp.json().catch(() => ({}));
      throw new Error(result.message || `审批提交失败 (${resp.status})`);
    }
    handleApprovalResolved(aid, sid);
  } catch (e) {
    removeApprovalFromQueue(aid);
    approvalSubmittingId.value = '';
    console.warn('审批响应失败:', e);
    showToast(e.message || '审批提交失败', 'warning');
    hideApprovalDialogs();
    showNextApproval(sid);
  }
};

const showQueuedApproval = (approval, sessionId) => {
  if (!approval?.approval_id || !sessionId) return;
  const dialogRef = getApprovalDialogRef(approval);
  if (!dialogRef?.show) return;
  dialogRef.show(
    { ...approval, queue_count: approvalQueue.value.length || 1 },
    (aid, message) => submitApproval(aid, true, message, sessionId),
    (aid, message) => submitApproval(aid, false, message, sessionId)
  );
};

const showNextApproval = (sessionId = currentSessionId.value) => {
  if (!sessionId || approvalSubmittingId.value) return;
  const nextApproval = approvalQueue.value[0] || null;
  if (!nextApproval) {
    hideApprovalDialogs();
    return;
  }
  hideApprovalDialogs();
  showQueuedApproval(nextApproval, sessionId);
};

const enqueueApproval = (event, eventData, sessionId) => {
  const approval = normalizeApprovalEventData(event, eventData);
  if (!approval.approval_id) return;
  const exists = approvalQueue.value.some(item => item?.approval_id === approval.approval_id);
  if (!exists) {
    approvalQueue.value = [...approvalQueue.value, approval];
  }
  // 双栏模式：工作栏内联处理，无需弹窗
  if (!showWorkPanel.value) showNextApproval(sessionId);
};

const handleApprovalResolved = (approvalId, sessionId) => {
  if (!approvalId) return;
  // 清除 ack 超时计时器
  if (_approvalAckTimers.has(approvalId)) {
    clearTimeout(_approvalAckTimers.get(approvalId));
    _approvalAckTimers.delete(approvalId);
  }
  const currentApprovalId = approvalQueue.value[0]?.approval_id || '';
  removeApprovalFromQueue(approvalId);
  if (approvalSubmittingId.value === approvalId) {
    approvalSubmittingId.value = '';
  }
  if (currentApprovalId === approvalId) {
    hideApprovalDialogs();
  }
  showNextApproval(sessionId);
};

const resetApprovalState = () => {
  approvalQueue.value = [];
  approvalSubmittingId.value = '';
  pendingUserInput.value = null;
  hideApprovalDialogs();
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

usePointerDownOutside({
  inside: [sessionMetaContainerRef],
  enabled: () => sessionMetaExpanded.value,
  target: () => window,
  onOutside: () => {
    sessionMetaExpanded.value = false;
  },
});

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
  if (force || isFollowing.value) {
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
// 用户主动向上滚动的累计距离，超过阈值才脱离跟随
let _userScrollUpAccum = 0;
// 脱离跟随的上滚距离阈值
const SCROLL_DETACH_THRESHOLD = 120;
// 恢复跟随的底部距离阈值
const SCROLL_REATTACH_THRESHOLD = 80;

const handleScroll = () => {
  const container = messagesRef.value;
  if (!container) return;

  updateScrollBottomGap();

  const currentTop = container.scrollTop;
  const delta = currentTop - _lastScrollTop;
  const atBottom = checkIfAtBottom();

  if (_isProgrammaticScroll) {
    // 程序滚动完成后，到达底部则结束程序滚动标记
    _lastScrollTop = currentTop;
    _userScrollUpAccum = 0;
    if (atBottom) {
      _isProgrammaticScroll = false;
    }
  } else {
    // 用户手动滚动
    if (delta < 0) {
      // 向上滚动 → 累积距离，超过阈值脱离跟随
      _userScrollUpAccum += Math.abs(delta);
      if (_userScrollUpAccum >= SCROLL_DETACH_THRESHOLD) {
        isFollowing.value = false;
      }
    } else if (delta > 0 && !isFollowing.value) {
      // 向下滚动且已脱离 → 接近底部时恢复跟随
      if (atBottom) {
        _userScrollUpAccum = 0;
        isFollowing.value = true;
      }
    }
    _lastScrollTop = currentTop;
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
  _userScrollUpAccum = 0;
  isFollowing.value = true;
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

const getMessageExecutionTime = (msg) => {
  const value = msg?.metadata?.execution_time;
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const getMessageFirstTokenTime = (msg) => {
  const value = msg?.metadata?.first_token_time;
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const formatExecutionTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`;
};

const formatPreciseExecutionTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(3)}s`;
};

const getMessageExecutionTimeText = (msg) => {
  const seconds = getMessageExecutionTime(msg);
  return seconds == null ? '' : `响应时间 ${formatExecutionTime(seconds)}`;
};

const getMessageExecutionTimeTitle = (msg) => {
  const executionTime = getMessageExecutionTime(msg);
  if (executionTime == null) return '';
  const lines = [`Run 执行时间：${formatPreciseExecutionTime(executionTime)}`];
  const firstTokenTime = getMessageFirstTokenTime(msg);
  if (firstTokenTime != null) {
    lines.push(`首 token：${formatPreciseExecutionTime(firstTokenTime)}`);
  }
  return lines.join('\n');
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
  const currentMsg = _activeRun.assistantMsgIndex >= 0
    ? messages.value[_activeRun.assistantMsgIndex]
    : null;
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
          pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(matched.metadata?.workspace_root || pendingWorkspaceRoot.value);
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

const updateRecentSession = (sessionId, content, timestamp) => {
  if (!sessionId) return;
  const time = timestamp || new Date().toISOString();
  const normalizedContent = (content || '').toString();
  const summary = normalizedContent.slice(0, 30);
  const normalizedWorkspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
  if (currentSessionId.value === sessionId && pendingWorkspaceRoot.value !== normalizedWorkspaceRoot) {
    pendingWorkspaceRoot.value = normalizedWorkspaceRoot;
  }
  const currentMetadata = currentSessionId.value === sessionId
    ? {
        ...(currentSessionTeam.value.trim() ? { team: currentSessionTeam.value.trim() } : {}),
        ...(normalizedWorkspaceRoot ? { workspace_root: normalizedWorkspaceRoot } : {}),
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
    if (idx === 0) {
      props.onSessionUpdated?.(item);
      return;
    }
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

const formatDurationMs = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`;
};

const getAssistantRuntimeStatusText = (msg) => {
  if (!msg || msg.role !== 'assistant' || msg.finished) return '';
  if (!_activeRun.active || messages.value[_activeRun.assistantMsgIndex] !== msg) return '';
  if (llmRetryState.value) return '模型调用重试中';
  if (_activeRun.phase === 'background_waiting') {
    const count = _activeRun.waiting?.pendingTaskCount
      || _activeRun.waiting?.pendingTaskIds?.length
      || _activeRun.waiting?.backgroundTaskIds?.length
      || 0;
    return count > 0 ? `等待后台任务完成 · ${count} 个任务` : '等待后台任务完成';
  }
  if (_activeRun.phase === 'approval_waiting') return '等待权限审批';
  if (_activeRun.phase === 'tool_running') return '工具执行中';
  if (_activeRun.phase === 'llm_streaming') return '模型输出中';
  if (_activeRun.phase === 'llm_waiting_first_token') return '等待模型响应';
  return isLoading.value ? '正在运行' : '';
};

const executionStatusText = computed(() => {
  if (llmRetryState.value && isLoading.value) {
    return `重试中 · ${formatRetryCountdown(llmRetryState.value)}`;
  }
  const status = sessionTaskInfo.value?.status;
  if (status === 'cancel_requested') return '停止中';
  if (isLoading.value) {
    if (_activeRun.phase === 'background_waiting') {
      const count = _activeRun.waiting?.pendingTaskCount
        || _activeRun.waiting?.pendingTaskIds?.length
        || _activeRun.waiting?.backgroundTaskIds?.length
        || 0;
      return count > 0 ? `等待后台任务 · ${count} 个任务` : '等待后台任务';
    }
    if (_activeRun.phase === 'approval_waiting') return '等待权限审批';
    if (_activeRun.phase === 'llm_streaming') return '模型输出中';
    if (_activeRun.phase === 'llm_waiting_first_token') return '等待模型响应';
    if (_activeRun.phase === 'tool_running') return '工具执行中';
    if (_activeRun.phase === 'retrying') return '重试中';
    return '运行中';
  }
  if (status === 'running') return '运行中';
  if (status === 'interrupted') return '已中断';
  if (status === 'failed') return '失败';
  if (status === 'completed') return '已完成';
  return '空闲';
});

const showExecutionPill = computed(() => {
  if (!currentSessionId.value) return false;
  if (isLoading.value) return true;
  if (sessionExecutionObservability.value?.task_id || sessionExecutionObservability.value?.run_id) return true;
  const status = sessionTaskInfo.value?.status;
  return status === 'running' || status === 'cancel_requested'
    || status === 'interrupted' || status === 'failed' || status === 'completed';
});

/**
 * 解析 task-notification 消息为结构化数组。
 * 优先从 _notifications（本地临时消息）取，否则解析 XML content。
 */
function parseTaskNotifications(msg) {
  if (msg._notifications?.length) return msg._notifications;
  const content = msg.content || '';
  const items = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const xml = m[1];
    const get = (tag) => { const r = new RegExp(`<${tag}>(.*?)</${tag}>`); const v = xml.match(r); return v ? v[1] : ''; };
    items.push({
      taskId: get('task-id') || 'unknown',
      status: get('status') || 'completed',
      resultType: get('result-type') || '',
    });
  }
  return items.length ? items : [{ taskId: 'unknown', status: 'completed', resultType: '' }];
}

function buildTaskNotificationMessage(sessionId, event) {
  const notifications = Array.isArray(event?.data?.notifications) ? event.data.notifications : [];
  const runId = event?.run_id || event?.data?.run_id || null;
  const content = notifications.map((item) => {
    const taskId = item.background_task_id || item.task_id || 'unknown';
    const outputPath = item.output_path || '';
    const status = item.status || 'completed';
    const returnCode = item.return_code;
    const resultType = item.result_type || '';
    const parts = ['<task-notification>'];
    parts.push(`<task-id>${taskId}</task-id>`);
    if (outputPath) parts.push(`<output-file>${outputPath}</output-file>`);
    parts.push(`<status>${status}</status>`);
    if (returnCode != null) parts.push(`<return-code>${returnCode}</return-code>`);
    if (resultType) parts.push(`<result-type>${resultType}</result-type>`);
    parts.push('</task-notification>');
    return parts.join('\n');
  }).join('\n\n');

  return {
    role: 'user',
    content,
    metadata: {
      source: 'system.bg_notification',
      run_id: runId,
    },
    _notifications: notifications.map((item) => ({
      taskId: item.background_task_id || item.task_id || 'unknown',
      status: item.status || 'completed',
      resultType: item.result_type || '',
    })),
    _bgRunId: runId,
    _bgSessionId: sessionId,
  };
}

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
      ...contents.map((_, i) => ({ type: 'chart', index: i }))
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

const ensureSession = async () => {
  if (currentSessionId.value) {
    connectSessionWS(currentSessionId.value);
    return currentSessionId.value;
  }
  const userId = (localStorage.getItem('userId') || '').trim();
  const workspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
  pendingWorkspaceRoot.value = workspaceRoot;
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
  const sessionId = result.data?.session_id || null;
  if (sessionId) {
    const now = new Date().toISOString();
    const sessionMetadata = {
      ...(team ? { team } : {}),
      ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
      ...(entryAgent ? { entry_agent: entryAgent } : {}),
      ...(result.data?.metadata || {}),
    };
    props.onSessionCreated?.({
      session_id: sessionId,
      title: result.data?.title || 'New Conversation',
      first_message: '',
      last_message: '',
      last_message_at: result.data?.last_message_at || now,
      unread_count: 0,
      metadata: sessionMetadata,
    });
    pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(sessionMetadata.workspace_root || '');
    pendingEntryAgent.value = sessionMetadata.entry_agent || '';
    currentSessionTeam.value = sessionMetadata.team || '';
    await router.push(getChatSessionPath(sessionId));
    if (currentSessionId.value !== sessionId) {
      currentSessionId.value = sessionId;
    }
    connectSessionWS(sessionId);
    await loadSessionFiles(sessionId);
  }
  return currentSessionId.value;
};

const handleStop = async () => {
  if (!currentSessionId.value) return;

  if (getWS()?.readyState === WebSocket.OPEN) {
    getWS().send(JSON.stringify({ type: 'stop' }));
  } else {
    try {
      await fetch('/api/agent/stream/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: currentSessionId.value })
      });
    } catch (e) {
      console.warn('停止请求发送失败:', e);
    }
  }
  sessionTaskInfo.value = {
    ...(sessionTaskInfo.value || {}),
    status: 'cancel_requested'
  };

  // 标记当前助手消息已完成
  const lastMsg = messages.value[messages.value.length - 1];
  if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.finished) {
    lastMsg.stopped = true;
    lastMsg.finished = true;
  }

  _activeRun.active = false;
  isLoading.value = false;
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

const handleEnterSituation = ({ artifactId, mapData }) => {
  // 手动触发态势大屏（从 MapRenderer 的按钮点击）
  situationArtifactId.value = artifactId;
  situationMapData.value = mapData;
  situationInfo.value = mapData?.assessment_summary || null;
  situationScreenActive.value = true;
};

const handleSend = async (payload = null) => {
  let content = (payload?.content ?? inputMessage.value).trim();
  const draftAttachments = Array.isArray(payload?.attachments) ? payload.attachments.slice() : pendingAttachments.value.slice();
  const replaceFromIndex = Number.isInteger(payload?.replaceFromIndex) ? payload.replaceFromIndex : null;
  const clearEditing = payload?.clearEditing === true;
  if ((!content && !draftAttachments.length) || isLoading.value) return;

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

  const attachments = await materializeAttachmentsForSend(draftAttachments, sessionId);

  if (replaceFromIndex != null) {
    messages.value = messages.value.slice(0, replaceFromIndex);
    cacheMessages(sessionId, messages.value);
    if (clearEditing) {
      resetEditingState({ closeDrawer: false });
      clearEditingAttachments();
    }
  }

  messages.value.push({ role: 'user', content: content, attachments: attachments, metadata: attachments.length ? { attachments } : {} });
  inputMessage.value = '';
  clearComposerAttachments();
  isFollowing.value = true;
  _userScrollUpAccum = 0;
  scrollToBottom(true);
  updateRecentSession(sessionId, content, new Date().toISOString());

  const assistantMsgIndex = messages.value.push(createAssistantMessage()) - 1;

  // 设置 _activeRun 状态，WS 事件处理器会使用
  _activeRun.active = true;
  _activeRun.assistantMsgIndex = assistantMsgIndex;
  _activeRun.runId = null;
  _activeRun.lastSeenSeq = 0;
  _activeRun.isReplaying = false;
  _activeRun.phase = 'llm_waiting_first_token';
  _activeRun.runStartedAt = Date.now() / 1000;
  _activeRun.firstTokenAt = null;
  _activeRun.firstTokenLatencyMs = null;
  _activeRun.latestLlmFirstTokenAt = null;
  _activeRun.lastChunkAt = null;
  _activeRun.waiting = null;
  _activeRun.outputCharCount = 0;

  beginOptimisticExecutionState(sessionId);
  isLoading.value = true;
  contextUsage.value = { used: 0, max: 0 };

  try {
    const body = {
      task: content,
      session_id: sessionId,
      use_v2: true,
      attachments: attachments.map(({ file_id, original_name, stored_name, mime, size, kind }) => ({
        file_id, original_name, stored_name, mime, size, kind,
      })),
    };
    const selectedLlm = getCurrentSelectedLlm();
    if (selectedLlm) {
      body.selected_llm = selectedLlm;
    }

    let result;
    if (getWS()?.readyState === WebSocket.OPEN) {
      // 通过 WS 发送，ack 结果由 handleWSMessage 中的 send.ack / send.error 处理
      getWS().send(JSON.stringify({ type: 'send', ...body }));
      // 设置 fallback：如果 WS 未回 ack，超时后 UI 不会卡死
      scheduleCommandFallback(sessionId, assistantMsgIndex, 30000);
      return;
    }

    // REST fallback
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    result = (await response.json()).data || {};

    if (!response.ok || !result.started) {
      const errorMsg = result.error || '启动执行失败';
      if (result.kind === 'command') {
        scheduleCommandFallback(sessionId, assistantMsgIndex);
        return;
      }
      throw new Error(errorMsg);
    }

    _activeRun.runId = result.run_id;

    if (result.kind === 'command') {
      scheduleCommandFallback(sessionId, assistantMsgIndex, 60000);
      return;
    }

  } catch (error) {
    console.error('Error sending message:', error);
    const currentMsg = messages.value[assistantMsgIndex];
    if (currentMsg) {
      currentMsg.content += `\n\n[System Error: ${error.message || 'Request failed'}]`;
      currentMsg.finished = true;
    }
    sessionTaskInfo.value = { ...(sessionTaskInfo.value || {}), status: 'failed' };
    _activeRun.active = false;
    _activeRun.phase = 'idle';
    _activeRun.waiting = null;
    _activeRun.runStartedAt = null;
    _activeRun.firstTokenAt = null;
    _activeRun.firstTokenLatencyMs = null;
    _activeRun.latestLlmFirstTokenAt = null;
    _activeRun.lastChunkAt = null;
    _activeRun.outputCharCount = 0;
    isLoading.value = false;
    showToast('消息发送失败', async () => {
      if (lastFailedSendContent.value) {
        inputMessage.value = lastFailedSendContent.value;
        await nextTick();
        handleSend();
      }
    });
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
  isFollowing.value = true;
  _userScrollUpAccum = 0;

  updateScrollBottomGap();
  scrollToBottom(true);
  loadEntryAgentOptions();
  loadActiveTeam();
  loadRecentSessions(true);
});

onUnmounted(() => {
  stopRetryTicker();
  disconnectSessionWS();

  // 不再通知后端停止任务 — Agent 继续在后台执行

  invalidateActiveStream();

  // 清理所有审批 ack 超时计时器
  for (const timer of _approvalAckTimers.values()) {
    clearTimeout(timer);
  }
  _approvalAckTimers.clear();
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
  height: 42px;
  padding: 8px 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05rem;
  /* font-family: var(--font-sans); */
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

.msg-action-btn.btn-execution-tree.active {
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  box-shadow: inset 0 0 0 1px rgba(var(--color-brand-accent-rgb), 0.28);
}

.msg-action-btn.btn-execution-tree:not(.active):hover {
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.06);
}

.msg-action-btn.btn-execution-tree.active:hover {
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.16);
}

.msg-action-btn.btn-execution-tree:active {
  transform: none;
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
