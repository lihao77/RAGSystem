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

            <!-- 任务分析卡片（仅在有多个子任务或复杂任务时显示） -->
            <div v-if="msg.taskAnalysis && (msg.taskAnalysis.subtask_count > 1 || msg.taskAnalysis.complexity !== 'simple')" class="task-analysis-card">
              <div class="card-header" @click="msg.taskAnalysis.expanded = !msg.taskAnalysis.expanded">
                <span class="icon">{{ msg.taskAnalysis.expanded ? '▼' : '▶' }}</span>
                <span class="card-title">🧠 任务分析</span>
                <span class="task-badge">{{ msg.taskAnalysis.complexity }}</span>
                <span class="subtask-count">{{ msg.taskAnalysis.subtask_count }} 个子任务</span>
              </div>
              <div v-if="msg.taskAnalysis.expanded" class="card-content">
                <div class="analysis-reasoning">{{ msg.taskAnalysis.reasoning }}</div>
              </div>
            </div>

            <!-- 子任务卡片列表 -->
            <div v-if="msg.subtasks && msg.subtasks.length > 0" class="subtasks-container">
              <div v-for="subtask in msg.subtasks" :key="subtask.order" class="subtask-card">
                <div class="subtask-header" @click="subtask.expanded = !subtask.expanded">
                  <span class="icon">{{ subtask.expanded ? '▼' : '▶' }}</span>
                  <span class="subtask-title">
                    <span class="subtask-number">步骤 {{ subtask.order }}</span>
                    <span class="subtask-agent">{{ subtask.agent_display_name }}</span>
                  </span>
                  <span class="subtask-status" :class="subtask.status">
                    {{ subtask.status === 'running' ? '⏳ 执行中' : subtask.status === 'success' ? '✅ 完成' : '❌ 失败' }}
                  </span>
                </div>

                <div v-if="!subtask.expanded" class="subtask-preview">
                  <div class="subtask-description">{{ subtask.description }}</div>
                  <div v-if="subtask.result_summary" class="subtask-summary">
                    {{ subtask.result_summary }}
                  </div>
                </div>

                <div v-if="subtask.expanded" class="subtask-details">
                  <div class="subtask-description-full">
                    <strong>任务描述：</strong>{{ subtask.description }}
                  </div>

                  <!-- 推理步骤 -->
                  <div v-if="subtask.thinking_steps && subtask.thinking_steps.length > 0" class="thinking-steps">
                    <div class="section-header">🤔 推理过程 ({{ subtask.thinking_steps.length }} 步)</div>
                    <div v-for="(step, stepIndex) in subtask.thinking_steps" :key="stepIndex" class="thinking-step">
                      <div class="step-meta">
                        <span class="step-number">{{ stepIndex + 1 }}</span>
                        <span class="step-type">
                          {{ step.has_actions ? '🔧 调用工具' : step.has_answer ? '✅ 得出答案' : '🤔 思考中' }}
                        </span>
                      </div>
                      <div class="step-content">{{ step.thought }}</div>
                    </div>
                  </div>

                  <!-- 工具调用 -->
                  <div v-if="subtask.tool_calls && subtask.tool_calls.length > 0" class="tool-calls">
                    <div class="section-header">
                      🔧 工具调用 ({{ subtask.tool_calls.length }} 个)
                      <span class="tools-stats">
                        <span class="stat-item">⏱️ {{ getTotalToolTimeForSubtask(subtask) }}s</span>
                        <span class="stat-item">✅ {{ getSuccessToolCountForSubtask(subtask) }}/{{ subtask.tool_calls.length }}</span>
                      </span>
                    </div>
                    <div v-for="(tool, tIndex) in subtask.tool_calls" :key="tIndex" class="tool-call-item">
                      <div class="tool-call-header">
                        <span class="tool-name">{{ tool.tool_name }}</span>
                        <span v-if="tool.elapsed_time" class="tool-time">{{ tool.elapsed_time.toFixed(2) }}s</span>
                        <span class="tool-status" :class="tool.status">
                          {{ tool.status === 'running' ? '⏳' : tool.status === 'success' ? '✅' : '❌' }}
                        </span>
                      </div>
                      <div v-if="Object.keys(tool.arguments || {}).length > 0" class="tool-arguments">
                        <div class="tool-section-title">参数</div>
                        <pre class="tool-json">{{ JSON.stringify(tool.arguments, null, 2) }}</pre>
                      </div>
                      <div v-if="tool.result" class="tool-result">
                        <div class="tool-section-title">结果</div>
                        <pre class="tool-json" :class="{ 'collapsed': !tool.showResult }" @click="tool.showResult = !tool.showResult">{{ JSON.stringify(tool.result, null, 2) }}</pre>
                        <div v-if="!tool.showResult" class="expand-hint">点击展开</div>
                      </div>
                    </div>
                  </div>

                  <!-- 结果摘要 -->
                  <div v-if="subtask.result_summary" class="subtask-result">
                    <div class="section-header">📋 结果摘要</div>
                    <div class="result-content">{{ subtask.result_summary }}</div>
                  </div>
                </div>
              </div>
            </div>

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

      <div class="chat-input-area">
        <div class="input-wrapper">
          <textarea
            v-model="inputMessage"
            @keydown.enter.prevent="handleEnter"
            placeholder="输入您的问题..."
            rows="1"
            ref="textareaRef"
          ></textarea>
          <button :disabled="!inputMessage.trim() || isLoading" @click="handleSend">
            发送
          </button>
        </div>
        <div class="disclaimer">
          AI 可能会生成不准确的信息，请核实重要信息。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, watch } from 'vue';
import axios from 'axios';
import { marked } from 'marked';

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const textareaRef = ref(null);
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

const adjustTextareaHeight = () => {
  const el = textareaRef.value;
  if (el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }
};

watch(inputMessage, adjustTextareaHeight);

const handleEnter = (e) => {
  if (!e.shiftKey) {
    handleSend();
  }
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

// 针对子任务的工具统计函数
const getTotalToolTimeForSubtask = (subtask) => {
  if (!subtask.tool_calls) return 0;
  return subtask.tool_calls.reduce((sum, tool) => sum + (tool.elapsed_time || 0), 0).toFixed(2);
};

const getSuccessToolCountForSubtask = (subtask) => {
  if (!subtask.tool_calls) return 0;
  return subtask.tool_calls.filter(tool => tool.status === 'success').length;
};

const copyToClipboard = async (text) => {
  try {
    const textToCopy = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    await navigator.clipboard.writeText(textToCopy);
    // 可以添加一个提示，但为了简洁先不加
  } catch (err) {
    console.error('复制失败:', err);
  }
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
  if (textareaRef.value) textareaRef.value.style.height = 'auto';

  // 强制滚动到底部（用户刚发送消息）
  isUserAtBottom.value = true;
  scrollToBottom(true);

  // Create empty assistant message
  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    taskAnalysis: null,  // 任务分析数据
    subtasks: [],        // 子任务列表（统一格式）
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
              currentMsg.subtasks.push({
                order: data.order,
                agent_name: data.agent_name,
                agent_display_name: data.agent_display_name,
                description: data.description,
                thinking_steps: [],   // 推理步骤
                tool_calls: [],       // 工具调用
                result_summary: '',   // 结果摘要
                status: 'running',    // running | success | error
                expanded: false       // 默认折叠
              });
            } else if (data.type === 'thought_structured') {
              // ReActAgent 的结构化思考
              const subtaskOrder = data.subtask_order;
              const subtask = currentMsg.subtasks.find(s => s.order === subtaskOrder);
              if (subtask) {
                subtask.thinking_steps.push({
                  thought: data.thought,
                  round: data.round,
                  has_actions: data.has_actions,
                  has_answer: data.has_answer
                });
              }
            } else if (data.type === 'tool_start') {
              // 工具开始执行
              const subtaskOrder = data.subtask_order;
              const subtask = currentMsg.subtasks.find(s => s.order === subtaskOrder);
              if (subtask) {
                subtask.tool_calls.push({
                  tool_name: data.tool_name,
                  arguments: data.arguments,
                  status: 'running',
                  index: data.index,
                  total: data.total,
                  showResult: false  // 默认折叠结果
                });
              }
            } else if (data.type === 'tool_end') {
              // 工具执行完成
              const subtaskOrder = data.subtask_order;
              const subtask = currentMsg.subtasks.find(s => s.order === subtaskOrder);
              if (subtask) {
                const toolIndex = subtask.tool_calls.findIndex(
                  t => t.tool_name === data.tool_name && t.status === 'running'
                );
                if (toolIndex >= 0) {
                  subtask.tool_calls[toolIndex].status = 'success';
                  subtask.tool_calls[toolIndex].result = data.result;
                  subtask.tool_calls[toolIndex].elapsed_time = data.elapsed_time;
                }
              }
            } else if (data.type === 'subtask_end') {
              // 子任务结束事件
              const subtask = currentMsg.subtasks.find(s => s.order === data.order);
              if (subtask) {
                subtask.result_summary = data.result_summary;
                subtask.status = data.success === false ? 'error' : 'success';
              }
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
  color: #e53e3e;
  background-color: #fff5f5;
}

.status-icon {
  font-size: 14px;
}

/* 任务分析卡片 */
.task-analysis-card {
  margin-top: 16px;
  border: 1px solid #dbeafe;
  border-radius: 8px;
  overflow: hidden;
  background-color: #eff6ff;
}

.card-header {
  background-color: #dbeafe;
  padding: 12px 16px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  transition: background-color 0.2s ease;
}

.card-header:hover {
  background-color: #bfdbfe;
}

.card-title {
  font-weight: 600;
  color: #1e40af;
}

.task-badge {
  padding: 2px 8px;
  background-color: #3b82f6;
  color: white;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.subtask-count {
  margin-left: auto;
  font-size: 12px;
  color: #1e40af;
  font-weight: 600;
}

.card-content {
  padding: 16px;
  background-color: #ffffff;
  border-top: 1px solid #bfdbfe;
}

.analysis-reasoning {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  /* 防止长文本撑开容器 */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
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

/* 输入区域 - 极简悬浮 */
.chat-input-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 24px;
  background: linear-gradient(to top, #ffffff 70%, rgba(255, 255, 255, 0));
  pointer-events: none;
}

.input-wrapper {
  max-width: 900px;
  margin: 0 auto;
  position: relative;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  background-color: #ffffff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: flex-end;
  padding: 12px;
  pointer-events: auto;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.input-wrapper:focus-within {
  border-color: #667eea;
  box-shadow: 0 4px 20px rgba(102, 126, 234, 0.15);
}

textarea {
  flex: 1;
  border: none;
  resize: none;
  padding: 8px 12px;
  font-family: inherit;
  font-size: 15px;
  max-height: 200px;
  outline: none;
  color: #2c3e50;
  line-height: 1.5;
}

textarea::placeholder {
  color: #a0aec0;
}

button {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  align-self: flex-end;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

button:disabled {
  background: #e2e8f0;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.disclaimer {
  text-align: center;
  font-size: 12px;
  color: #a0aec0;
  margin-top: 12px;
  font-weight: 400;
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
