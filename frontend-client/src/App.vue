<template>
  <div class="chat-container">
    <div class="chat-sidebar">
      <div class="new-chat-btn" @click="startNewChat">
        <span>+ 新对话</span>
      </div>
      <div class="history-list">
        <div class="history-item" v-for="(item, index) in history" :key="index">
          {{ item.title || '新对话' }}
        </div>
      </div>
      <div class="user-profile">
        <div class="avatar">U</div>
        <div class="username">User</div>
      </div>
    </div>

    <div class="chat-main">
      <div class="chat-messages" ref="messagesRef" @scroll="handleScroll">
        <div v-if="messages.length === 0" class="welcome-screen">
          <h1>多智能体系统</h1>
          <p class="welcome-subtitle">开始对话，探索知识图谱</p>
        </div>

        <div v-else v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
          <div class="message-avatar">
            {{ msg.role === 'user' ? 'U' : 'AI' }}
          </div>
          <div class="message-content">
            <!-- 加载状态（仅在助手消息且无任何内容时显示） -->
            <div v-if="msg.role === 'assistant' && !msg.content && !msg.taskAnalysis && (!msg.subtasks || msg.subtasks.length === 0)" class="loading-dots">
              <span>.</span><span>.</span><span>.</span>
            </div>

            <!-- 任务分析卡片 -->
            <TaskAnalysisCard
              v-if="msg.taskAnalysis"
              :taskAnalysis="msg.taskAnalysis"
              @update:expanded="msg.taskAnalysis.expanded = $event"
            />

            <!-- 子任务卡片列表 -->
            <div v-if="msg.subtasks && msg.subtasks.length > 0" class="subtasks-container">
              <SubtaskCard
                v-for="subtask in msg.subtasks"
                :key="subtask.order"
                :subtask="subtask"
                @update:expanded="subtask.expanded = $event"
              />
            </div>

            <!-- 多模态内容展示（图表、地图等） -->
            <MultimodalContent
              v-if="msg.multimodalContents && msg.multimodalContents.length > 0"
              :contents="msg.multimodalContents"
            />

            <!-- 最终答案（仅助手消息） -->
            <div v-if="msg.role === 'assistant' && msg.content && msg.content.trim()" class="final-answer">
              <div class="answer-header">💡 最终答案</div>
              <div class="message-text" v-html="renderMarkdown(msg.content)"></div>
            </div>

            <!-- 用户消息 -->
            <div v-if="msg.role === 'user' && msg.content && msg.content.trim()" class="user-message-text">
              {{ msg.content }}
            </div>

            <!-- 状态更新显示 -->
            <div v-if="msg.status && msg.status.length > 0" class="status-updates">
              <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-item">
                <div v-if="status.type === 'error'" class="status-error">
                  <span class="status-icon">❌</span>
                  <span class="status-text">{{ status.content }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ChatInput
        v-model="inputMessage"
        :isLoading="isLoading"
        @send="handleSend"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, watch } from 'vue';
import axios from 'axios';
import { marked } from 'marked';
import SubtaskCard from './components/SubtaskCard.vue';
import ToolCallsList from './components/ToolCallsList.vue';
import ThinkingSteps from './components/ThinkingSteps.vue';
import TaskAnalysisCard from './components/TaskAnalysisCard.vue';
import ChatInput from './components/ChatInput.vue';
import MultimodalContent from './components/MultimodalContent.vue';

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const history = ref([]);

// 打字机效果的定时器存储
const typewriterTimers = ref(new Map());

// 用户是否在底部（用于智能滚动）
const isUserAtBottom = ref(true);

const startNewChat = () => {
  messages.value = [];
  inputMessage.value = '';
  // 清除所有打字机定时器
  typewriterTimers.value.forEach(timer => clearTimeout(timer));
  typewriterTimers.value.clear();
  isUserAtBottom.value = true;
};

/**
 * 打字机效果：逐字显示文本
 * @param {Object} target - 目标对象
 * @param {String} key - 要更新的键名
 * @param {String} text - 要显示的文本
 * @param {Number} speed - 打字速度（毫秒/字符），默认 30ms
 * @param {String} timerId - 定时器 ID，用于清除
 * @param {Boolean} showCursor - 是否显示打字光标
 */
const typewriter = (target, key, text, speed = 30, timerId = null, showCursor = false) => {
  // 如果已有该字段的内容，先清除对应的定时器
  if (timerId && typewriterTimers.value.has(timerId)) {
    clearTimeout(typewriterTimers.value.get(timerId));
    typewriterTimers.value.delete(timerId);
  }

  let currentIndex = 0;
  const originalText = target[key] || '';

  // 如果需要立即显示（speed = 0），直接设置文本
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
      if (timerId) {
        typewriterTimers.value.set(timerId, timer);
      }

      scrollToBottom();
    } else {
      // 打字完成，清除定时器引用
      if (timerId) {
        typewriterTimers.value.delete(timerId);
      }
    }
  };

  type();
};

/**
 * 为数组项添加打字机效果
 * @param {Array} array - 目标数组
 * @param {Object} item - 要添加的对象
 * @param {String} textKey - 对象中包含文本的键名
 * @param {Number} speed - 打字速度
 * @param {String} timerId - 定时器 ID
 */
const typewriterPush = (array, item, textKey = 'thought', speed = 20, timerId = null) => {
  // 创建一个临时对象，文本字段初始为空
  const tempItem = { ...item, [textKey]: '' };
  array.push(tempItem);

  // 获取数组中的引用（最后一个元素）
  const targetItem = array[array.length - 1];

  // 使用打字机效果填充文本
  const text = item[textKey];
  if (text) {
    typewriter(targetItem, textKey, text, speed, timerId);
  }
};

const renderMarkdown = (text) => {
  return marked.parse(text || '');
};

/**
 * 检查用户是否在底部
 */
const checkIfAtBottom = () => {
  if (!messagesRef.value) return true;

  const container = messagesRef.value;
  const threshold = 100; // 距离底部100px以内认为是在底部

  return (
    container.scrollHeight - container.scrollTop - container.clientHeight < threshold
  );
};

/**
 * 智能滚动到底部
 * 只在用户原本就在底部时才自动滚动
 */
const scrollToBottom = async (force = false) => {
  await nextTick();

  if (!messagesRef.value) return;

  // 如果强制滚动或用户在底部，则滚动到底部
  if (force || isUserAtBottom.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
};

/**
 * 监听用户滚动，更新是否在底部的状态
 */
const handleScroll = () => {
  isUserAtBottom.value = checkIfAtBottom();
};

const sendMessage = (text) => {
  inputMessage.value = text;
  handleSend();
};

const formatToolResult = (result) => {
  if (typeof result === 'string') {
    return result.length > 200 ? result.substring(0, 200) + '...' : result;
  }

  // 如果是对象，尝试智能提取关键信息
  if (typeof result === 'object' && result !== null) {
    // 检索结果类型（有 results 数组）
    if (result.data && result.data.results) {
      const count = result.data.count || result.data.results.length;
      const query = result.data.query || '未知查询';
      return `检索成功：找到 ${count} 条结果\n查询: ${query}`;
    }

    // 知识图谱查询结果（有 results 数组但没有 data 包裹）
    if (result.results && Array.isArray(result.results)) {
      return `查询成功：返回 ${result.results.length} 条记录`;
    }

    // Schema 查询结果
    if (result.data && result.data.labels) {
      const labelCount = result.data.labels.length;
      const relCount = result.data.relationships.length;
      return `Schema 查询成功：${labelCount} 个标签，${relCount} 个关系类型`;
    }

    // 通用成功消息
    if (result.success) {
      return result.message || 'Success';
    }

    // 降级：显示 JSON 的前 200 字符
    const jsonStr = JSON.stringify(result, null, 2);
    return jsonStr.length > 200 ? jsonStr.substring(0, 200) + '...' : jsonStr;
  }

  return JSON.stringify(result, null, 2);
};

const getTotalToolTime = (msg) => {
  if (!msg.tool_calls) return 0;
  return msg.tool_calls.reduce((sum, tool) => sum + (tool.elapsed_time || 0), 0).toFixed(2);
};

const getSuccessToolCount = (msg) => {
  if (!msg.tool_calls) return 0;
  return msg.tool_calls.filter(tool => tool.status === 'success').length;
};

const handleSend = async () => {
  const content = inputMessage.value.trim();
  if (!content || isLoading.value) return;

  // Add user message
  messages.value.push({
    role: 'user',
    content: content
  });

  inputMessage.value = '';

  // 强制滚动到底部（用户刚发送消息）
  isUserAtBottom.value = true;
  scrollToBottom(true);

  // Create empty assistant message
  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    taskAnalysis: null,  // 任务分析数据
    subtasks: [],        // 子任务列表（统一格式）
    multimodalContents: [], // 多模态内容列表（图表、地图等）
    status: []
  }) - 1;

  isLoading.value = true; // 标记加载中，用于禁用发送按钮

  try {
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        task: content,
        session_id: null // 可选：如果需要会话记忆
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            const currentMsg = messages.value[assistantMsgIndex];

            if (data.type === 'chunk') {
              // 最终答案处理
              const content = data.content;

              // 判断是真流式（MasterAgent 通用对话）还是完整答案（ReActAgent）
              // 真流式：短内容（<= 10字符）且已有内容
              // 完整答案：长内容或第一个chunk
              if (content.length <= 10 && currentMsg.content.length > 0) {
                // 真流式：直接追加
                currentMsg.content += content;
              } else {
                // 完整答案：使用打字机效果
                typewriter(currentMsg, 'content', content, 15, `msg-${assistantMsgIndex}-content`);
              }
            } else if (data.type === 'task_analysis') {
              // 任务分析事件
              currentMsg.taskAnalysis = {
                complexity: data.complexity,
                subtask_count: data.subtask_count,
                reasoning: data.reasoning,
                expanded: true  // 默认展开
              };
            } else if (data.type === 'subtask_start') {
              // 子任务开始事件
              // 先折叠之前所有的子任务（如果有多个）
              if (currentMsg.subtasks.length > 0) {
                currentMsg.subtasks.forEach(st => st.expanded = false);
              }

              currentMsg.subtasks.push({
                order: data.order,
                agent_name: data.agent_name,
                agent_display_name: data.agent_display_name,
                description: data.description,
                react_steps: [],      // ReAct 推理步骤（新增）
                tool_calls: [],       // 工具调用（保留用于兼容性）
                result_summary: '',   // 结果摘要
                status: 'running',    // running | success | error
                expanded: true,       // 新开始的子任务默认展开
                currentStep: null     // 当前正在进行的步骤
              });
            } else if (data.type === 'thought_structured') {
              // ReActAgent 的结构化思考
              const subtaskOrder = data.subtask_order;
              const subtask = currentMsg.subtasks.find(s => s.order === subtaskOrder);
              if (subtask) {
                // 创建新的 ReAct 步骤
                const newStep = {
                  round: data.round,
                  thought: data.thought,
                  toolCalls: [],
                  expanded: true
                };
                subtask.react_steps.push(newStep);
                subtask.currentStep = newStep; // 保存当前步骤的引用
              }
            } else if (data.type === 'tool_start') {
              // 工具开始执行
              const subtaskOrder = data.subtask_order;
              const subtask = currentMsg.subtasks.find(s => s.order === subtaskOrder);
              if (subtask && subtask.currentStep) {
                // 将工具调用添加到当前步骤
                subtask.currentStep.toolCalls.push({
                  tool_name: data.tool_name,
                  arguments: data.arguments,
                  status: 'running',
                  index: data.index,
                  total: data.total,
                  showResult: false,
                  showArgs: false
                });

                // 兼容性：也添加到 tool_calls 数组
                subtask.tool_calls.push({
                  tool_name: data.tool_name,
                  arguments: data.arguments,
                  status: 'running',
                  index: data.index,
                  total: data.total,
                  showResult: false
                });
              }
            } else if (data.type === 'tool_end') {
              // 工具执行完成
              const subtaskOrder = data.subtask_order;
              const subtask = currentMsg.subtasks.find(s => s.order === subtaskOrder);
              if (subtask && subtask.currentStep) {
                // 更新当前步骤中的工具状态
                const toolIndex = subtask.currentStep.toolCalls.findIndex(
                  t => t.tool_name === data.tool_name && t.status === 'running'
                );
                if (toolIndex >= 0) {
                  subtask.currentStep.toolCalls[toolIndex].status = 'success';
                  subtask.currentStep.toolCalls[toolIndex].result = data.result;
                  subtask.currentStep.toolCalls[toolIndex].elapsed_time = data.elapsed_time;
                }

                // 兼容性：同步更新 tool_calls 数组
                const oldToolIndex = subtask.tool_calls.findIndex(
                  t => t.tool_name === data.tool_name && t.status === 'running'
                );
                if (oldToolIndex >= 0) {
                  subtask.tool_calls[oldToolIndex].status = 'success';
                  subtask.tool_calls[oldToolIndex].result = data.result;
                  subtask.tool_calls[oldToolIndex].elapsed_time = data.elapsed_time;
                }
              }
            } else if (data.type === 'subtask_end') {
              // 子任务结束事件
              const subtask = currentMsg.subtasks.find(s => s.order === data.order);
              if (subtask) {
                subtask.result_summary = data.result_summary;
                subtask.status = data.success === false ? 'error' : 'success';
                // 子任务完成后自动折叠（如果有多个子任务）
                if (currentMsg.subtasks.length > 1) {
                  subtask.expanded = false;
                }
              }
            } else if (data.type === 'chart_generated') {
              // 图表生成事件 - 实时渲染图表
              currentMsg.multimodalContents.push({
                type: 'chart',
                echartsConfig: data.echarts_config,
                title: data.title || '数据可视化',
                chartType: data.chart_type || 'bar'
              });
            } else if (data.type === 'map_generated') {
              // 地图生成事件 - 实时渲染地图
              currentMsg.multimodalContents.push({
                type: 'map',
                mapData: data.mapData,
                title: data.title || '地图可视化'
              });
            } else if (data.type === 'error') {
              currentMsg.status.push({ type: 'error', content: data.content });
            }

            scrollToBottom();
          } catch (e) {
            console.error('Error parsing SSE data:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error sending message:', error);
    messages.value[assistantMsgIndex].content += '\n\n[系统错误: 请求失败，请稍后再试]';
  } finally {
    isLoading.value = false;
    scrollToBottom();
  }
};

// 组件挂载时初始化
onMounted(() => {
  // 初始状态：用户在底部
  isUserAtBottom.value = true;
});
</script>

<style scoped>
/* 复制提示动画 */
@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes slideOut {
  from {
    transform: translateX(0);
    opacity: 1;
  }
  to {
    transform: translateX(100%);
    opacity: 0;
  }
}

/* 打字机光标动画 */
@keyframes blink {
  0%, 50% {
    opacity: 1;
  }
  51%, 100% {
    opacity: 0;
  }
}

.typing-cursor::after {
  content: '▋';
  animation: blink 1s infinite;
  margin-left: 2px;
  color: #667eea;
}

/* 扁平化简约设计 */
.chat-container {
  display: flex;
  height: 100vh;
  width: 100%;
  background-color: #fafafa;
  color: #2c3e50;
}

/* 侧边栏 - 极简黑白 */
.chat-sidebar {
  width: 260px;
  background-color: #1a1a1a;
  color: #e0e0e0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  border-right: 1px solid #2a2a2a;
}

.new-chat-btn {
  background-color: transparent;
  border: 1px solid #404040;
  border-radius: 8px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 24px;
  text-align: left;
  font-size: 14px;
  color: #e0e0e0;
}

.new-chat-btn:hover {
  background-color: #2a2a2a;
  border-color: #505050;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  margin-bottom: 16px;
}

.history-item {
  padding: 10px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  color: #b0b0b0;
  transition: all 0.2s ease;
}

.history-item:hover {
  background-color: #2a2a2a;
  color: #e0e0e0;
}

.user-profile {
  padding: 16px 12px;
  border-top: 1px solid #2a2a2a;
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 32px;
  height: 32px;
  background-color: #3a3a3a;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e0e0e0;
  font-weight: 500;
  font-size: 14px;
}

.username {
  font-size: 14px;
  color: #b0b0b0;
}

/* 主聊天区域 - 纯白简洁 */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  background-color: #ffffff;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 32px 24px;
  padding-bottom: 180px;
}

/* 欢迎屏幕 - 大留白 */
.welcome-screen {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.welcome-screen h1 {
  font-size: 36px;
  font-weight: 300;
  color: #1a1a1a;
  margin: 0;
  letter-spacing: -0.5px;
}

.welcome-subtitle {
  font-size: 15px;
  font-weight: 400;
  color: #718096;
  margin: 0;
}

/* 消息 - 扁平卡片 */
.message {
  display: flex;
  gap: 16px;
  padding: 24px 0;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

.message.user {
  background-color: transparent;
}

.message.assistant {
  background-color: transparent;
}

.message-avatar {
  width: 40px;
  height: 40px;
  min-width: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 500;
  font-size: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.message.user .message-avatar {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.message.assistant .message-avatar {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.message-content {
  flex: 1;
  line-height: 1.7;
  font-size: 15px;
  color: #2c3e50;
  /* 防止长文本撑开容器 */
  min-width: 0;
  word-wrap: break-word;
  overflow-wrap: break-word;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.message-text {
  margin-bottom: 12px;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* 状态更新 - 极简标签 */
.status-updates {
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status-item {
  padding: 6px 12px;
  border-radius: 16px;
  background-color: #f5f5f5;
  border: none;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-agent-start {
  color: #5a67d8;
}

.status-error {
  color: #dc2626;
  background-color: #fee2e2;
  padding: 12px 16px;
  border-left: 4px solid #dc2626;
  border-radius: 6px;
  font-weight: 500;
}

.status-icon {
  font-size: 14px;
}

/* 子任务卡片容器 */
.subtasks-container {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 子任务卡片 */
.subtask-card {
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
  background-color: #ffffff;
  transition: box-shadow 0.2s ease;
  /* 添加淡入动画 */
  animation: fadeInUp 0.5s ease;
}

.subtask-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.subtask-header {
  background-color: #f8f9fa;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #e8e8e8;
  transition: background-color 0.2s ease;
}

.subtask-header:hover {
  background-color: #f0f0f0;
}

.subtask-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.subtask-number {
  font-weight: 700;
  color: #4a5568;
  font-size: 13px;
}

.subtask-agent {
  padding: 2px 8px;
  background-color: #e9d5ff;
  color: #6b21a8;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
}

.subtask-status {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 12px;
}

.subtask-status.running {
  background-color: #fef3c7;
  color: #d97706;
}

.subtask-status.success {
  background-color: #dcfce7;
  color: #16a34a;
}

.subtask-status.error {
  background-color: #fee2e2;
  color: #dc2626;
}

/* 子任务预览（折叠状态） */
.subtask-preview {
  padding: 12px 16px;
  background-color: #fafafa;
  /* 添加淡入动画 */
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.subtask-description {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.5;
  margin-bottom: 8px;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.subtask-summary {
  font-size: 12px;
  color: #718096;
  font-style: italic;
  padding-left: 16px;
  border-left: 2px solid #cbd5e0;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* 子任务详情（展开状态） */
.subtask-details {
  padding: 16px;
  background-color: #ffffff;
  /* 添加展开动画 */
  animation: expandDown 0.3s ease;
}

@keyframes expandDown {
  from {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
  }
  to {
    opacity: 1;
    max-height: 2000px;
    padding-top: 16px;
    padding-bottom: 16px;
  }
}

.subtask-description-full {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.section-header {
  font-size: 13px;
  font-weight: 600;
  color: #4a5568;
  margin: 16px 0 12px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 推理步骤 */
.thinking-steps {
  margin-bottom: 16px;
}

.thinking-step {
  margin-bottom: 12px;
  padding: 12px;
  background-color: #faf5ff;
  border-left: 3px solid #a855f7;
  border-radius: 4px;
  /* 添加淡入动画 */
  animation: fadeInUp 0.4s ease;
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.thinking-step:last-child {
  margin-bottom: 0;
}

.step-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
}

.step-type {
  font-size: 12px;
  color: #718096;
  font-weight: 500;
}

.step-content {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  margin-left: 36px;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* 工具调用（在子任务内） */
.tool-calls {
  margin-bottom: 16px;
}

.tool-call-item {
  padding: 12px;
  background-color: #f8f9fa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  margin-bottom: 8px;
  /* 添加淡入动画 */
  animation: fadeInUp 0.4s ease;
}

.tool-call-item:last-child {
  margin-bottom: 0;
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #e8e8e8;
}

.tool-name {
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  font-weight: 600;
  color: #5a67d8;
  flex: 1;
}

.tool-time {
  font-size: 12px;
  color: #a0aec0;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
}

.tool-status {
  font-size: 14px;
}

.tool-status.running {
  opacity: 0.6;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.tool-arguments,
.tool-result {
  margin-top: 8px;
}

.tool-section-title {
  font-size: 11px;
  text-transform: uppercase;
  color: #718096;
  font-weight: 600;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.tool-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.tool-arguments .tool-json {
  cursor: default;
}

.tool-arguments .tool-json:hover {
  background-color: #f8f9fa;
}

.tool-result .tool-json {
  cursor: pointer;
}

.tool-json {
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 12px;
  color: #4a5568;
  background-color: #f8f9fa;
  padding: 10px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-all;
  white-space: pre-wrap;
  max-width: 100%;
  transition: background-color 0.2s ease;
}

.tool-result .tool-json:hover {
  background-color: #e8eaed;
}

.tool-json.collapsed {
  max-height: 100px;
  overflow: hidden;
  position: relative;
}

.tool-json.collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: linear-gradient(to bottom, transparent, #f8f9fa);
}

.expand-hint {
  font-size: 11px;
  color: #718096;
  text-align: center;
  margin-top: 4px;
  font-style: italic;
}

.tools-stats {
  display: flex;
  gap: 12px;
  font-size: 11px;
  font-weight: 500;
}

.stat-item {
  color: #718096;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 子任务结果 */
.subtask-result {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #f0f0f0;
}

.result-content {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  padding: 12px;
  background-color: #f0fdf4;
  border-left: 3px solid #22c55e;
  border-radius: 4px;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.copy-btn {
  background: transparent;
  border: 1px solid #e8e8e8;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #718096;
  transition: all 0.2s ease;
  margin: 0;
  box-shadow: none;
  align-self: auto;
}

.copy-btn:hover {
  background-color: #f5f5f5;
  border-color: #d0d0d0;
  color: #4a5568;
  transform: none;
  box-shadow: none;
}

.copy-btn:active {
  background-color: #e8e8e8;
}

.tool-arguments {
  margin-bottom: 12px;
}

.tool-arguments pre {
  background-color: #f8f8f8;
  padding: 10px;
  border-radius: 6px;
  font-size: 12px;
  color: #4a5568;
  overflow-x: auto;
  margin: 0;
  border: 1px solid #e8e8e8;
}

.tool-result {
  margin-top: 12px;
}

.tool-result-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.toggle-btn {
  background: transparent;
  border: 1px solid #e8e8e8;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: #718096;
  transition: all 0.2s ease;
  margin: 0;
  box-shadow: none;
  font-weight: 500;
}

.toggle-btn:hover {
  background-color: #f5f5f5;
  border-color: #d0d0d0;
  color: #4a5568;
}

.toggle-btn:active {
  background-color: #e8e8e8;
}

.tool-result-summary {
  background-color: #f0fdf4;
  border: 1px solid #d1fae5;
  padding: 12px;
  border-radius: 6px;
  font-size: 13px;
  color: #065f46;
  line-height: 1.6;
  white-space: pre-wrap;
}

.tool-result-full {
  background-color: #f8f8f8;
  border: 1px solid #e8e8e8;
  padding: 12px;
  border-radius: 6px;
  font-size: 12px;
  color: #4a5568;
  line-height: 1.6;
  max-height: 400px;
  overflow-y: auto;
  margin: 0;
}

.tool-result-full::-webkit-scrollbar {
  width: 6px;
}

.tool-result-full::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.tool-result-full::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
}

/* Loading 动画 - 简约点 */
.loading-dots {
  display: flex;
  gap: 4px;
}

.loading-dots span {
  width: 8px;
  height: 8px;
  background-color: #cbd5e0;
  border-radius: 50%;
  animation: loading 1.4s infinite ease-in-out both;
}

.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }
.loading-dots span:nth-child(3) { animation-delay: 0s; }

@keyframes loading {
  0%, 80%, 100% {
    transform: scale(0.8);
    opacity: 0.5;
  }
  40% {
    transform: scale(1.1);
    opacity: 1;
  }
}

/* Markdown 样式优化 */
.message-content :deep(h1),
.message-content :deep(h2),
.message-content :deep(h3) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.3;
}

.message-content :deep(h1) { font-size: 24px; }
.message-content :deep(h2) { font-size: 20px; }
.message-content :deep(h3) { font-size: 17px; }

.message-content :deep(p) {
  margin-bottom: 12px;
}

.message-content :deep(code) {
  background-color: #f5f5f5;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
}

.message-content :deep(pre) {
  background-color: #f5f5f5;
  padding: 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 16px 0;
}

.message-content :deep(pre code) {
  background-color: transparent;
  padding: 0;
}

.message-content :deep(ul),
.message-content :deep(ol) {
  padding-left: 24px;
  margin-bottom: 12px;
}

.message-content :deep(li) {
  margin-bottom: 4px;
}

/* 滚动条美化 */
.chat-messages::-webkit-scrollbar,
.history-list::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-track,
.history-list::-webkit-scrollbar-track {
  background: transparent;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #e0e0e0;
  border-radius: 3px;
}

.history-list::-webkit-scrollbar-thumb {
  background: #3a3a3a;
  border-radius: 3px;
}

/* 最终答案样式 */
.final-answer {
  margin-top: 24px;
  padding: 20px;
  background: linear-gradient(135deg, #f6f8fb 0%, #ffffff 100%);
  border-left: 4px solid #10b981;
  border-radius: 8px;
  /* 添加淡入动画 */
  animation: fadeInUp 0.5s ease;
}

.answer-header {
  font-size: 16px;
  font-weight: 600;
  color: #10b981;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.final-answer .message-text {
  font-size: 15px;
  line-height: 1.7;
  color: #2d3748;
}

/* 用户消息文本样式 */
.user-message-text {
  font-size: 15px;
  line-height: 1.6;
  color: #1a202c;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: #d0d0d0;
}

.history-list::-webkit-scrollbar-thumb:hover {
  background: #4a4a4a;
}
</style>
