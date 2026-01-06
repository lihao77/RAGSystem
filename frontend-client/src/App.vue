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
      <div class="chat-messages" ref="messagesRef">
        <div v-if="messages.length === 0" class="welcome-screen">
          <h1>多智能体系统</h1>
          <p class="welcome-subtitle">开始对话，探索知识图谱</p>
        </div>

        <div v-else v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
          <div class="message-avatar">
            {{ msg.role === 'user' ? 'U' : 'AI' }}
          </div>
          <div class="message-content">
            <div class="message-text" v-html="renderMarkdown(msg.content)"></div>

            <!-- 工具调用可视化 -->
            <div v-if="msg.tool_calls && msg.tool_calls.length > 0" class="tool-calls">
              <div class="tool-calls-header">
                <span>🔧 工具调用记录</span>
                <div class="tools-stats">
                  <span class="stat-item">{{ msg.tool_calls.length }} 个工具</span>
                  <span class="stat-item">⏱️ {{ getTotalToolTime(msg) }}s</span>
                  <span class="stat-item">✅ {{ getSuccessToolCount(msg) }}/{{ msg.tool_calls.length }}</span>
                </div>
              </div>
              <div v-for="(tool, tIndex) in msg.tool_calls" :key="tIndex" class="tool-call-item">
                <div class="tool-call-header">
                  <span class="tool-name">{{ tool.tool_name }}</span>
                  <span v-if="tool.elapsed_time" class="tool-time">{{ tool.elapsed_time.toFixed(2) }}s</span>
                  <span class="tool-status" :class="tool.status">
                    {{ tool.status === 'running' ? '⏳' : tool.status === 'success' ? '✅' : '❌' }}
                  </span>
                </div>
                <div v-if="Object.keys(tool.arguments || {}).length > 0" class="tool-arguments">
                  <div class="tool-section-header">
                    <span class="tool-section-title">参数</span>
                    <button @click="copyToClipboard(tool.arguments)" class="copy-btn" title="复制">
                      📋
                    </button>
                  </div>
                  <pre>{{ JSON.stringify(tool.arguments, null, 2) }}</pre>
                </div>
                <div v-if="tool.result && tool.status === 'success'" class="tool-result">
                  <div class="tool-section-header">
                    <span class="tool-section-title">结果</span>
                    <div class="tool-result-actions">
                      <button @click="tool.showFullResult = !tool.showFullResult" class="toggle-btn" title="切换详情">
                        {{ tool.showFullResult ? '收起' : '详情' }}
                      </button>
                      <button @click="copyToClipboard(tool.result)" class="copy-btn" title="复制完整结果">
                        📋
                      </button>
                    </div>
                  </div>
                  <div v-if="!tool.showFullResult" class="tool-result-summary">
                    {{ formatToolResult(tool.result) }}
                  </div>
                  <pre v-else class="tool-result-full">{{ JSON.stringify(tool.result, null, 2) }}</pre>
                </div>
              </div>
            </div>

            <!-- 状态更新显示（不包括 thought，thought 在下方单独显示） -->
            <div v-if="msg.status && msg.status.length > 0" class="status-updates">
              <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-item">
                <div v-if="status.type === 'agent_start'" class="status-agent-start">
                  <span class="status-icon">🤖</span>
                  <span class="status-text">{{ status.content }}</span>
                </div>
                <div v-else-if="status.type === 'error'" class="status-error">
                  <span class="status-icon">❌</span>
                  <span class="status-text">{{ status.content }}</span>
                </div>
              </div>
            </div>

            <!-- MasterAgent 的任务分析 -->
            <div v-if="msg.thinking && msg.thinking.trim()" class="thinking-process master-thinking">
              <div class="thinking-header" @click="msg.showMasterThinking = !msg.showMasterThinking">
                <span class="icon">{{ msg.showMasterThinking ? '▼' : '▶' }}</span>
                <span class="thinking-title">🧠 任务分析</span>
              </div>
              <div v-if="msg.showMasterThinking" class="thinking-content master-analysis">
                <pre class="analysis-text">{{ msg.thinking }}</pre>
              </div>
            </div>

            <!-- ReActAgent 的结构化思考过程 -->
            <div v-if="msg.thinking_steps && msg.thinking_steps.length > 0" class="thinking-process agent-thinking">
              <div class="thinking-header" @click="msg.showAgentThinking = !msg.showAgentThinking">
                <span class="icon">{{ msg.showAgentThinking ? '▼' : '▶' }}</span>
                <span class="thinking-title">🤖 推理步骤 ({{ msg.thinking_steps.length }} 步)</span>
              </div>
              <div v-if="msg.showAgentThinking" class="thinking-content">
                <div v-for="(step, stepIndex) in msg.thinking_steps" :key="stepIndex" class="thinking-step">
                  <div class="thinking-step-header">
                    <span class="step-number">{{ stepIndex + 1 }}</span>
                    <span class="step-actions">
                      {{ step.has_actions ? '🔧 调用工具' : step.has_answer ? '✅ 得出答案' : '🤔 思考中' }}
                    </span>
                  </div>
                  <div class="thinking-step-content">{{ step.thought }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="isLoading" class="message assistant">
          <div class="message-avatar">AI</div>
          <div class="message-content">
            <div class="loading-dots">
              <span>.</span><span>.</span><span>.</span>
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

const startNewChat = () => {
  messages.value = [];
  inputMessage.value = '';
  // 清除所有打字机定时器
  typewriterTimers.value.forEach(timer => clearTimeout(timer));
  typewriterTimers.value.clear();
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

const scrollToBottom = async () => {
  await nextTick();
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
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
  scrollToBottom();

  // Create empty assistant message
  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    thinking: '',
    thinking_steps: [],  // 新增：结构化思考步骤
    tool_calls: [],      // 新增：工具调用记录
    status: [],
    showMasterThinking: true,  // MasterAgent 任务分析默认展开
    showAgentThinking: true    // ReActAgent 推理步骤默认展开
  }) - 1;

  isLoading.value = true; // 保持 loading 状态直到完成，但因为有了空消息，实际上不会显示 loading dots

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
              // 最终答案 - 使用打字机效果
              typewriter(currentMsg, 'content', data.content, 15, `msg-${assistantMsgIndex}-content`);
            } else if (data.type === 'thought') {
              // MasterAgent 的任务分析 - 使用打字机效果
              const newText = data.content + '\n';
              typewriter(currentMsg, 'thinking', newText, 10, `msg-${assistantMsgIndex}-thinking`);
            } else if (data.type === 'thought_structured') {
              // ReActAgent 的结构化思考 - 使用打字机效果添加到数组
              const timerId = `msg-${assistantMsgIndex}-step-${currentMsg.thinking_steps.length}`;
              typewriterPush(
                currentMsg.thinking_steps,
                {
                  thought: data.thought,
                  round: data.round,
                  has_actions: data.has_actions,
                  has_answer: data.has_answer
                },
                'thought',
                15,
                timerId
              );
            } else if (data.type === 'tool_start') {
              // 工具开始执行 - 立即显示（不需要打字机效果）
              currentMsg.tool_calls.push({
                tool_name: data.tool_name,
                arguments: data.arguments,
                status: 'running',
                index: data.index,
                total: data.total
              });
            } else if (data.type === 'tool_end') {
              // 工具执行完成 - 立即更新（不需要打字机效果）
              const toolIndex = currentMsg.tool_calls.findIndex(
                t => t.tool_name === data.tool_name && t.status === 'running'
              );
              if (toolIndex >= 0) {
                currentMsg.tool_calls[toolIndex].status = 'success';
                currentMsg.tool_calls[toolIndex].result = data.result;
                currentMsg.tool_calls[toolIndex].elapsed_time = data.elapsed_time;
              }
            } else if (data.type === 'agent_start') {
              currentMsg.status.push({ type: 'agent_start', content: data.content });
            } else if (data.type === 'agent_end') {
              // 可选：添加结束状态
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
}

.message-text {
  margin-bottom: 12px;
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

/* 思考过程 - 扁平折叠 */
.thinking-process {
  margin-top: 16px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
  background-color: #fafafa;
}

/* MasterAgent 任务分析 - 浅蓝色主题 */
.master-thinking {
  border-color: #dbeafe;
  background-color: #eff6ff;
}

.master-thinking .thinking-header {
  background-color: #dbeafe;
  border-bottom: 1px solid #bfdbfe;
}

.master-thinking .thinking-title {
  color: #1e40af;
}

.master-analysis {
  background-color: #eff6ff;
  border-top: 1px solid #bfdbfe;
}

.analysis-text {
  margin: 0;
  padding: 0;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  color: #1e40af;
  white-space: pre-wrap;
  line-height: 1.6;
  background-color: transparent;
}

/* ReActAgent 推理步骤 - 浅紫色主题 */
.agent-thinking {
  border-color: #e9d5ff;
  background-color: #faf5ff;
}

.agent-thinking .thinking-header {
  background-color: #e9d5ff;
  border-bottom: 1px solid #d8b4fe;
}

.agent-thinking .thinking-title {
  color: #6b21a8;
}

.thinking-header {
  background-color: transparent;
  padding: 12px 16px;
  font-size: 13px;
  color: #718096;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  transition: color 0.2s ease;
}

.thinking-header:hover {
  color: #4a5568;
}

.thinking-title {
  font-weight: 600;
}

.thinking-header .icon {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.thinking-content {
  padding: 16px;
  background-color: #ffffff;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  color: #4a5568;
  white-space: pre-wrap;
  line-height: 1.6;
  border-top: 1px solid #e8e8e8;
}

/* 结构化思考步骤 */
.thinking-step {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;
}

.thinking-step:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.thinking-step-header {
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

.step-actions {
  font-size: 12px;
  color: #718096;
  font-weight: 500;
}

.thinking-step-content {
  margin-left: 36px;
  line-height: 1.6;
  color: #4a5568;
}

/* 工具调用可视化 */
.tool-calls {
  margin: 16px 0;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
  background-color: #fafafa;
}

.tool-calls-header {
  background-color: #f5f5f5;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #4a5568;
  border-bottom: 1px solid #e8e8e8;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.tools-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  font-weight: 500;
}

.stat-item {
  color: #718096;
  display: flex;
  align-items: center;
  gap: 4px;
}

.tool-call-item {
  padding: 16px;
  background-color: #ffffff;
  border-bottom: 1px solid #f0f0f0;
}

.tool-call-item:last-child {
  border-bottom: none;
}

.tool-call-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f5f5f5;
}

.tool-name {
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 14px;
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
  font-size: 16px;
}

.tool-status.running {
  opacity: 0.6;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.tool-section-title {
  font-size: 11px;
  text-transform: uppercase;
  color: #718096;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.tool-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
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

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: #d0d0d0;
}

.history-list::-webkit-scrollbar-thumb:hover {
  background: #4a4a4a;
}
</style>
