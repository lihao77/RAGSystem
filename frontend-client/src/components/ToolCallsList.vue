<template>
  <div class="tool-calls">
    <div class="section-header">
      🔧 工具调用 ({{ toolCalls.length }} 个)
      <span class="tools-stats">
        <span class="stat-item">⏱️ {{ totalTime }}s</span>
        <span class="stat-item">✅ {{ successCount }}/{{ toolCalls.length }}</span>
      </span>
    </div>
    <div v-for="(tool, index) in toolCalls" :key="index" class="tool-call-item">
      <div class="tool-call-header">
        <span class="tool-name">{{ tool.tool_name }}</span>
        <span v-if="tool.elapsed_time" class="tool-time">{{ tool.elapsed_time.toFixed(2) }}s</span>
        <span class="tool-status" :class="tool.status">
          {{ getStatusIcon(tool.status) }}
        </span>
      </div>

      <!-- 参数 -->
      <div v-if="Object.keys(tool.arguments || {}).length > 0" class="tool-arguments">
        <div class="tool-section-title">参数</div>
        <pre class="tool-json">{{ JSON.stringify(tool.arguments, null, 2) }}</pre>
      </div>

      <!-- 结果 -->
      <div v-if="tool.result" class="tool-result">
        <div class="tool-section-header">
          <div class="tool-section-title">结果</div>
          <button @click.stop="copyToClipboard(tool.result)" class="copy-btn" title="复制结果">
            📋
          </button>
        </div>
        <pre
          class="tool-json"
          :class="{ 'collapsed': !tool.showResult }"
          @click="tool.showResult = !tool.showResult"
        >{{ JSON.stringify(tool.result, null, 2) }}</pre>
        <div v-if="!tool.showResult" class="expand-hint">点击展开</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, defineProps } from 'vue';

const props = defineProps({
  toolCalls: {
    type: Array,
    required: true
  }
});

const totalTime = computed(() => {
  return props.toolCalls
    .reduce((sum, tool) => sum + (tool.elapsed_time || 0), 0)
    .toFixed(2);
});

const successCount = computed(() => {
  return props.toolCalls.filter(tool => tool.status === 'success').length;
});

const getStatusIcon = (status) => {
  const iconMap = {
    'running': '⏳',
    'success': '✅',
    'error': '❌'
  };
  return iconMap[status] || '';
};

const copyToClipboard = async (text) => {
  try {
    const textToCopy = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
    await navigator.clipboard.writeText(textToCopy);

    // 显示复制成功提示
    const notification = document.createElement('div');
    notification.textContent = '✓ 已复制';
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #10b981;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: slideIn 0.3s ease;
    `;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.animation = 'slideOut 0.3s ease';
      setTimeout(() => document.body.removeChild(notification), 300);
    }, 2000);
  } catch (err) {
    console.error('复制失败:', err);
  }
};
</script>

<style scoped>
.tool-calls {
  margin-bottom: 16px;
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

.tool-call-item {
  padding: 12px;
  background-color: #f8f9fa;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  margin-bottom: 8px;
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
}

.copy-btn:hover {
  background-color: #f5f5f5;
  border-color: #cbd5e0;
  color: #4a5568;
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
</style>
