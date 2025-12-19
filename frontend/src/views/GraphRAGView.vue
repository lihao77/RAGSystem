<template>
  <div class="graphrag-container">
    <!-- 主内容区 - 2列布局 -->
    <div class="main-content">
      <!-- 对话区 -->
      <div class="chat-column">
        <el-scrollbar class="chat-scrollbar" ref="chatScrollbar">
          <div class="chat-container">
            <!-- 欢迎消息 -->
            <div v-if="messages.length === 0" class="welcome-message">
              <div class="welcome-icon">
                <el-icon :size="48"><ChatDotRound /></el-icon>
              </div>
              <h2>时空知识图谱问答系统</h2>
              <p>基于广西水旱灾害的智能问答助手</p>
              <div class="welcome-hints">
                <div class="hint-item">
                  <el-icon><Clock /></el-icon>
                  <span>时序推理</span>
                </div>
                <div class="hint-item">
                  <el-icon><MapLocation /></el-icon>
                  <span>空间分析</span>
                </div>
                <div class="hint-item">
                  <el-icon><Share /></el-icon>
                  <span>因果追踪</span>
                </div>
              </div>
            </div>

            <!-- 对话消息流 -->
            <div class="messages-flow">
              <template v-for="(msg, idx) in messages" :key="idx">
                <!-- 用户消息 -->
                <div v-if="msg.role === 'user'" class="message-item user-message">
                  <div class="message-content">
                    <div class="message-avatar">
                      <el-avatar :size="32" style="background: #409eff;">
                        <el-icon><User /></el-icon>
                      </el-avatar>
                    </div>
                    <div class="message-bubble user-bubble">
                      <div class="message-text">{{ msg.content }}</div>
                    </div>
                  </div>
                </div>

                <!-- AI 消息 -->
                <div v-if="msg.role === 'assistant'" class="message-item assistant-message">
                  <div class="message-content">
                    <div class="message-avatar">
                      <el-avatar :size="32" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                        <el-icon><Cpu /></el-icon>
                      </el-avatar>
                    </div>
                    <div class="message-bubble assistant-bubble">
                      <!-- 工具调用过程（如果有） -->
                      <div v-if="getMessageTools(idx).length > 0" class="tool-calls-section">
                        <div class="section-header" @click="toggleMessageTools(idx)">
                          <el-icon><Operation /></el-icon>
                          <span>推理过程</span>
                          <el-tag size="small" type="info">{{ getMessageTools(idx).length }} 步</el-tag>
                          <el-icon class="toggle-icon" :class="{ expanded: isMessageToolsExpanded(idx) }">
                            <ArrowDown />
                          </el-icon>
                        </div>
                        <div v-show="isMessageToolsExpanded(idx)" class="tool-calls-list">
                          <div 
                            v-for="(tool, tIdx) in getMessageTools(idx)" 
                            :key="tIdx"
                            class="tool-call-card"
                          >
                            <div class="tool-header">
                              <div class="tool-step">
                                <span class="step-badge">{{ tIdx + 1 }}</span>
                                <span class="tool-name">{{ getToolDisplayName(tool.name) }}</span>
                              </div>
                              <el-tag 
                                size="small" 
                                :type="tool.result?.success ? 'success' : 'danger'"
                              >
                                {{ tool.result?.success ? '成功' : '失败' }}
                              </el-tag>
                            </div>
                            
                            <!-- 工具详情可展开 -->
                            <el-collapse accordion class="tool-details-collapse">
                              <el-collapse-item>
                                <template #title>
                                  <span class="collapse-trigger">
                                    <el-icon><View /></el-icon>
                                    查看详情
                                  </span>
                                </template>
                                
                                <div class="tool-detail-content">
                                  <!-- 参数 -->
                                  <div v-if="tool.arguments" class="detail-block">
                                    <div class="block-label">📋 输入参数</div>
                                    <div class="param-tags">
                                      <el-tag 
                                        v-for="(val, key) in formatToolArgs(tool.arguments)" 
                                        :key="key"
                                        size="small"
                                      >
                                        {{ key }}: {{ val }}
                                      </el-tag>
                                    </div>
                                  </div>

                                  <!-- Cypher -->
                                  <div v-if="tool.result?.data?.cypher" class="detail-block">
                                    <div class="block-label">
                                      💻 Cypher 查询
                                      <el-button 
                                        size="small" 
                                        text 
                                        type="primary"
                                        @click="copyCypher(tool.result.data.cypher)"
                                      >
                                        <el-icon><DocumentCopy /></el-icon>
                                        复制
                                      </el-button>
                                    </div>
                                    <pre class="code-block">{{ tool.result.data.cypher }}</pre>
                                  </div>

                                  <!-- 结果 -->
                                  <div v-if="getToolResults(tool).length > 0" class="detail-block">
                                    <div class="block-label">
                                      📊 返回结果
                                      <el-tag size="small" type="success">
                                        {{ getToolResults(tool).length }} 条
                                      </el-tag>
                                    </div>
                                    <div class="results-preview">
                                      {{ JSON.stringify(getToolResults(tool).slice(0, 2), null, 2) }}
                                      <span v-if="getToolResults(tool).length > 2" class="more-indicator">
                                        ... 还有 {{ getToolResults(tool).length - 2 }} 条
                                      </span>
                                    </div>
                                  </div>

                                  <!-- 图谱数据 -->
                                  <div v-if="getToolGraphData(tool)" class="detail-block">
                                    <div class="block-label">🌐 图谱数据</div>
                                    <div class="graph-stats">
                                      <span>{{ getToolGraphData(tool).nodes?.length || 0 }} 节点</span>
                                      <span>{{ getToolGraphData(tool).relationships?.length || 0 }} 关系</span>
                                    </div>
                                  </div>
                                </div>
                              </el-collapse-item>
                            </el-collapse>
                          </div>
                        </div>
                      </div>

                      <!-- AI 回答 -->
                      <div class="answer-section">
                        <div class="message-text" v-html="formatContent(msg.content)"></div>
                      </div>

                      <!-- 图表渲染（如果有） -->
                      <div v-if="getMessageChart(idx)" class="chart-section">
                        <ChartRenderer 
                          :chart-config="getMessageChart(idx).echarts_config"
                          :chart-type="getMessageChart(idx).chart_type"
                          :data-summary="getMessageChart(idx).data_summary"
                          height="400px"
                        />
                      </div>

                      <!-- 消息元信息 -->
                      <div class="message-meta">
                        <span class="meta-time">{{ formatTime(msg.timestamp) }}</span>
                        <el-button 
                          text 
                          size="small"
                          @click="copyText(msg.content)"
                        >
                          <el-icon><DocumentCopy /></el-icon>
                          复制
                        </el-button>
                      </div>
                    </div>
                  </div>
                </div>
              </template>

              <!-- 加载中 -->
              <div v-if="loading" class="message-item assistant-message">
                <div class="message-content">
                  <div class="message-avatar">
                    <el-avatar :size="32" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);">
                      <el-icon><Cpu /></el-icon>
                    </el-avatar>
                  </div>
                  <div class="message-bubble assistant-bubble">
                    <div class="typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </el-scrollbar>

        <!-- 输入区 - 固定在底部 -->
        <div class="chat-input-section">
          <div class="input-container">
            <!-- 示例查询快捷按钮 -->
            <div v-if="messages.length === 0 && exampleQuestions.length > 0" class="example-chips">
              <div 
                v-for="(example, idx) in exampleQuestions.slice(0, 3)" 
                :key="idx"
                class="example-chip"
                @click="selectExample(example.question)"
              >
                <el-icon><Lightning /></el-icon>
                {{ example.label }}
              </div>
            </div>

            <!-- 主输入框 -->
            <div class="input-wrapper">
              <div class="input-box" :class="{ focused: inputFocused, hasContent: question.trim() }">
                <textarea
                  ref="inputTextarea"
                  v-model="question"
                  class="message-input"
                  placeholder="向时空知识图谱提问..."
                  rows="1"
                  :disabled="loading"
                  @focus="inputFocused = true"
                  @blur="inputFocused = false"
                  @input="adjustTextareaHeight"
                  @keydown.enter.exact.prevent="sendQuestion"
                  @keydown.enter.shift.exact="newLine"
                ></textarea>
                
                <div class="input-actions">
                  <!-- 更多选项按钮 -->
                  <el-popover
                    placement="top-start"
                    :width="280"
                    trigger="click"
                  >
                    <template #reference>
                      <button class="action-btn icon-btn" title="示例查询">
                        <el-icon><Menu /></el-icon>
                      </button>
                    </template>
                    <div class="examples-menu">
                      <div class="menu-title">示例查询</div>
                      <div 
                        v-for="(example, idx) in exampleQuestions"
                        :key="idx"
                        class="menu-item"
                        @click="selectExample(example.question)"
                      >
                        <div class="item-label">{{ example.label }}</div>
                        <div class="item-type">{{ example.typeLabel }}</div>
                      </div>
                    </div>
                  </el-popover>

                  <!-- 清空按钮 -->
                  <button 
                    v-if="messages.length > 0"
                    class="action-btn icon-btn" 
                    title="清空对话"
                    @click="clear"
                  >
                    <el-icon><Delete /></el-icon>
                  </button>

                  <!-- 发送按钮 -->
                  <button 
                    class="action-btn send-btn"
                    :class="{ active: question.trim() && !loading }"
                    :disabled="!question.trim() || loading"
                    @click="sendQuestion"
                    title="发送 (Enter)"
                  >
                    <el-icon v-if="loading">
                      <Loading />
                    </el-icon>
                    <el-icon v-else>
                      <Promotion />
                    </el-icon>
                  </button>
                </div>
              </div>
              
              <!-- 提示信息 -->
              <div class="input-hint">
                <span class="hint-text">
                  <kbd>Enter</kbd> 发送
                  <span class="hint-divider">·</span>
                  <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右列：推理详情 -->
      <div v-if="toolCalls.length > 0" class="right-column" :class="{ collapsed: sidebarCollapsed }">
        <div class="sidebar-toggle" @click="sidebarCollapsed = !sidebarCollapsed">
          <el-icon>
            <DArrowLeft v-if="sidebarCollapsed" />
            <DArrowRight v-else />
          </el-icon>
        </div>
        <div v-show="!sidebarCollapsed" class="sidebar-content">
          <el-collapse v-model="activeNames" class="detail-collapse">
          <!-- 推理过程 -->
          <el-collapse-item name="1">
              <template #title>
                <div class="collapse-head">
                  <el-icon><Operation /></el-icon>
                  <span>推理过程</span>
                  <el-tag size="small" type="info">{{ toolCalls.length }} 步</el-tag>
                </div>
              </template>
              <div class="collapse-body">
                <div class="tool-steps-list">
                  <div 
                    v-for="(tool, idx) in toolCalls" 
                    :key="idx"
                    class="tool-step-item"
                  >
                    <div class="step-header-main">
                      <div class="step-index-inline">{{ idx + 1 }}</div>
                      <div class="step-name-inline">
                        {{ getToolDisplayName(tool.name) }}
                      </div>
                      <el-tag 
                        v-if="hasToolData(tool)" 
                        size="small" 
                        :type="getToolDataType(tool)"
                      >
                        {{ getToolDataSummary(tool) }}
                      </el-tag>
                      <el-tag 
                        :type="tool.result?.success ? 'success' : 'danger'"
                        size="small"
                        style="margin-left: auto;"
                      >
                        {{ tool.result?.success ? '✓' : '✗' }}
                      </el-tag>
                    </div>
                    
                    <div class="step-details-expandable">
                      <el-collapse>
                        <!-- 参数 -->
                        <el-collapse-item 
                          v-if="tool.arguments && Object.keys(tool.arguments).length > 0"
                          :name="`${idx}-args`"
                        >
                          <template #title>
                            <span class="detail-item-title">📋 输入参数</span>
                          </template>
                          <div class="detail-content">
                            <el-tag 
                              v-for="(val, key) in formatToolArgs(tool.arguments)" 
                              :key="key"
                              size="small"
                              style="margin: 2px;"
                            >
                              {{ key }}: {{ val }}
                            </el-tag>
                          </div>
                        </el-collapse-item>
                        
                        <!-- Cypher 查询 -->
                        <el-collapse-item 
                          v-if="tool.result && tool.result.data && tool.result.data.cypher"
                          :name="`${idx}-cypher`"
                        >
                          <template #title>
                            <span class="detail-item-title">
                              💻 Cypher 查询
                              <el-button 
                                size="small" 
                                text 
                                type="primary"
                                @click.stop="copyCypher(tool.result.data.cypher)"
                                style="margin-left: 8px;"
                              >
                                复制
                              </el-button>
                            </span>
                          </template>
                          <pre class="code-display-inline">{{ tool.result.data.cypher }}</pre>
                        </el-collapse-item>
                        
                        <!-- 查询结果 -->
                        <el-collapse-item 
                          v-if="getToolResults(tool).length > 0"
                          :name="`${idx}-results`"
                        >
                          <template #title>
                            <span class="detail-item-title">
                              📊 查询结果
                              <el-tag size="small" type="success" style="margin-left: 8px;">
                                {{ getToolResults(tool).length }} 条
                              </el-tag>
                            </span>
                          </template>
                          <pre class="code-display-inline">{{ JSON.stringify(getToolResults(tool), null, 2) }}</pre>
                        </el-collapse-item>
                        
                        <!-- 图谱数据 -->
                        <el-collapse-item 
                          v-if="getToolGraphData(tool)"
                          :name="`${idx}-graph`"
                        >
                          <template #title>
                            <span class="detail-item-title">
                              🌐 图谱数据
                              <el-tag size="small" type="success" style="margin-left: 8px;">
                                {{ getToolGraphData(tool).nodes?.length || 0 }} 节点 / 
                                {{ getToolGraphData(tool).relationships?.length || 0 }} 关系
                              </el-tag>
                            </span>
                          </template>
                          <div class="graph-data-preview">
                            <div v-if="getToolGraphData(tool).nodes?.length > 0" style="margin-bottom: 8px;">
                              <div style="font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #606266;">节点示例:</div>
                              <pre class="code-display-inline">{{ JSON.stringify(getToolGraphData(tool).nodes.slice(0, 2), null, 2) }}</pre>
                            </div>
                            <div v-if="getToolGraphData(tool).relationships?.length > 0">
                              <div style="font-weight: 600; margin-bottom: 4px; font-size: 12px; color: #606266;">关系示例:</div>
                              <pre class="code-display-inline">{{ JSON.stringify(getToolGraphData(tool).relationships.slice(0, 2), null, 2) }}</pre>
                            </div>
                          </div>
                        </el-collapse-item>
                      </el-collapse>
                    </div>
                  </div>
                </div>
              </div>
            </el-collapse-item>

            <!-- 汇总统计 -->
            <el-collapse-item name="2" v-if="lastCypher || lastResults.length > 0">
              <template #title>
                <div class="collapse-head">
                  <el-icon><DataAnalysis /></el-icon>
                  <span>汇总统计</span>
                  <el-tag v-if="lastResults.length > 0" size="small" type="info">
                    总计 {{ lastResults.length }} 条结果
                  </el-tag>
                </div>
              </template>
              <div class="collapse-body">
                <div class="summary-stats">
                  <el-descriptions :column="2" border size="small">
                    <el-descriptions-item label="工具调用">{{ toolCalls.length }} 个</el-descriptions-item>
                    <el-descriptions-item label="查询结果">{{ lastResults.length }} 条</el-descriptions-item>
                    <el-descriptions-item label="图谱节点">{{ graphData.nodes.length }} 个</el-descriptions-item>
                    <el-descriptions-item label="图谱关系">{{ graphData.links.length }} 个</el-descriptions-item>
                    <el-descriptions-item label="Cypher查询" :span="2">
                      {{ lastCypher ? '已生成' : '无' }}
                    </el-descriptions-item>
                  </el-descriptions>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ElMessage } from 'element-plus';
import { 
  Search, DataAnalysis, Delete, ChatDotRound, DocumentCopy, Document, DataLine, 
  Connection, Share, Clock, MapLocation, Memo, Refresh, Tools, Operation, 
  Tickets, Edit, Position, RefreshLeft, User, Cpu, Grid, CircleCheck, ChatLineRound, View,
  ArrowDown, DArrowLeft, DArrowRight, Lightning, Menu, Loading, Promotion
} from '@element-plus/icons-vue';
import ForceGraph from 'force-graph';
import * as graphragService from '../api/graphragService';
import ChartRenderer from '../components/ChartRenderer.vue';

defineOptions({ name: 'GraphRAGView' });

// 配置 marked
marked.setOptions({
  breaks: true, // 支持换行
  gfm: true, // 启用 GitHub Flavored Markdown
  headerIds: false,
  mangle: false
});

const question = ref('');
const selectedExample = ref('');
const loading = ref(false);
const messages = ref([]);
const lastCypher = ref('');
const lastResults = ref([]);
const schema = ref(null);
const activeNames = ref([]); // 默认全部折叠
const expandedSteps = ref(''); // 展开的推理步骤
const graphContainer = ref(null);
const chatScrollbar = ref(null);
const inputTextarea = ref(null);
const inputFocused = ref(false);
const toolCalls = ref([]); // 工具调用记录
const messageToolsMap = ref({}); // 消息和工具调用的映射
const expandedMessageTools = ref({}); // 展开的消息推理过程
const messageChartsMap = ref({}); // 消息和图表的映射
const sidebarCollapsed = ref(false); // 右侧边栏折叠状态
let graphInstance = null;

// 图谱数据
const graphData = ref({
  nodes: [],
  links: []
});

// 示例问题
const exampleQuestions = ref([
  { 
    type: 'temporal', 
    typeLabel: '时序分析',
    label: '2020年潘厂水库的时序演化', 
    question: '2020年潘厂水库发生了什么，请展示完整的时序演化过程' 
  },
  { 
    type: 'causal', 
    typeLabel: '统计分析',
    label: '2017年7月广西灾害损失', 
    question: '2017年7月广西因灾害导致的经济损失和人员伤亡情况' 
  },
  { 
    type: 'causal', 
    typeLabel: '因果追踪',
    label: '潘厂水库泄洪影响链', 
    question: '潘厂水库2020年泄洪造成了什么影响？追踪完整的因果链' 
  },
  { 
    type: 'spatial', 
    typeLabel: '空间关联',
    label: '南宁市周边地区灾害', 
    question: '查询南宁市及其周边地区在2023年的灾害关联关系' 
  },
  { 
    type: 'temporal', 
    typeLabel: '时序对比',
    label: '2018-2019年度对比', 
    question: '对比2018年和2019年广西的受灾情况' 
  }
]);

const lastResultsStr = computed(() => {
  try {
    return JSON.stringify(lastResults.value, null, 2);
  } catch (e) {
    return String(lastResults.value);
  }
});

const schemaStr = computed(() => {
  try {
    return JSON.stringify(schema.value, null, 2);
  } catch (e) {
    return '';
  }
});

// 从查询结果中提取图谱数据
function extractGraphData(graphDataFromBackend) {
  if (!graphDataFromBackend || !graphDataFromBackend.nodes) {
    return { nodes: [], links: [] };
  }
  
  const nodes = graphDataFromBackend.nodes.map(node => {
    // 构建节点显示名称，优先使用 properties 中的名称
    const name = node.properties?.名称 || 
                 node.properties?.name || 
                 node.properties?.标题 || 
                 node.properties?.id ||
                 `节点 ${node.id}`;
    
    // 构建属性信息用于显示
    let attributesText = '';
    if (node.attributes && Array.isArray(node.attributes) && node.attributes.length > 0) {
      attributesText = '\n属性:\n' + node.attributes
        .filter(attr => attr && (attr.type || attr.value))
        .map(attr => `  • ${attr.type || '未知'}: ${attr.value || ''}`)
        .join('\n');
    }
    
    return {
      id: `node_${node.id}`,
      name: name,
      label: node.labels?.[0] || '未知',
      properties: node.properties,
      attributes: node.attributes || [],
      color: getNodeColor(node.labels?.[0]),
      displayInfo: `${node.labels?.[0] || '未知'}: ${name}${attributesText}`
    };
  });
  
  const links = (graphDataFromBackend.relationships || [])
    .filter(rel => rel.source && rel.target)
    .map(rel => ({
      source: `node_${rel.source}`,
      target: `node_${rel.target}`,
      label: rel.type || '相关',
      properties: rel.properties || {},
      color: '#999'
    }));
  
  return { nodes, links };
}

// 根据标签返回颜色
function getNodeColor(label) {
  const colorMap = {
    '事件': '#ff6b6b',
    '地点': '#4ecdc4',
    '时间': '#95e1d3',
    '人物': '#f38181',
    '组织': '#aa96da',
    '灾害': '#ff9ff3',
    '统计': '#feca57',
    '措施': '#48dbfb',
    '影响': '#ff6348',
    '原因': '#a29bfe',
    'State': '#5f9ea0',
    'Attribute': '#daa520',
    'entity': '#9370db'
  };
  return colorMap[label] || '#409eff';
}

// 渲染图谱
function renderGraph() {
  if (!graphContainer.value || graphData.value.nodes.length === 0) return;
  
  // 销毁旧实例
  if (graphInstance) {
    graphContainer.value.innerHTML = '';
    graphInstance = null;
  }
  
  // 确保容器有尺寸
  const containerWidth = graphContainer.value.clientWidth || 360;
  const containerHeight = 350;
  
  console.log('渲染图谱:', {
    nodes: graphData.value.nodes.length,
    links: graphData.value.links.length,
    containerWidth,
    containerHeight
  });
  
  // 创建新实例
  graphInstance = ForceGraph()(graphContainer.value)
    .width(containerWidth)
    .height(containerHeight)
    .graphData(graphData.value)
    .nodeId('id')
    .nodeLabel(node => node.displayInfo || `${node.label}: ${node.name}`)
    .nodeColor(node => node.color)
    .nodeRelSize(6)
    .nodeCanvasObject((node, ctx, globalScale) => {
      // 绘制节点
      const label = node.name || 'Node';
      const fontSize = 12 / globalScale;
      ctx.font = `${fontSize}px Sans-Serif`;
      const textWidth = ctx.measureText(label).width;
      const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2);

      // 绘制圆形节点
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI, false);
      ctx.fill();

      // 绘制文字背景
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y + 7, ...bckgDimensions);

      // 绘制文字
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#333';
      ctx.fillText(label, node.x, node.y + 8);
    })
    .linkLabel(link => {
      let label = link.label;
      if (link.properties && Object.keys(link.properties).length > 0) {
        const propsText = Object.entries(link.properties)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        label += `\n${propsText}`;
      }
      return label;
    })
    .linkColor(() => '#999')
    .linkWidth(2)
    .linkDirectionalArrowLength(6)
    .linkDirectionalArrowRelPos(1)
    .backgroundColor('#fafafa')
    .onNodeClick(node => {
      console.log('节点详情:', node);
      if (node.attributes && node.attributes.length > 0) {
        console.log('节点属性:', node.attributes);
      }
    })
    .d3Force('charge').strength(-300)
    .d3Force('link').distance(100);
  
  // 缩放到适合大小
  setTimeout(() => {
    if (graphInstance) {
      graphInstance.zoomToFit(400, 20);
    }
  }, 500);
}

// 监听图谱数据变化
watch(() => graphData.value.nodes.length, () => {
  if (graphData.value.nodes.length > 0 && activeNames.value.includes('0')) {
    nextTick(() => {
      renderGraph();
    });
  }
});

// 选择示例
function onExampleSelect(value) {
  if (value) {
    question.value = value;
    selectedExample.value = '';
  }
}

// 选择示例（新方法）
function selectExample(exampleQuestion) {
  question.value = exampleQuestion;
  selectedExample.value = '';
  nextTick(() => {
    adjustTextareaHeight();
    if (inputTextarea.value) {
      inputTextarea.value.focus();
    }
  });
}

// 自动调整输入框高度
function adjustTextareaHeight() {
  if (!inputTextarea.value) return;
  inputTextarea.value.style.height = 'auto';
  const scrollHeight = inputTextarea.value.scrollHeight;
  const maxHeight = 200; // 最大高度
  inputTextarea.value.style.height = Math.min(scrollHeight, maxHeight) + 'px';
}

// 换行
function newLine() {
  question.value += '\n';
  nextTick(() => {
    adjustTextareaHeight();
  });
}

// 获取工具显示名称
function getToolDisplayName(toolName) {
  const nameMap = {
    'query_knowledge_graph_with_nl': '自然语言查询',
    'search_knowledge_graph': '知识图谱搜索',
    'get_entity_relations': '关系探索',
    'analyze_temporal_pattern': '时序分析',
    'find_causal_chain': '因果链追踪',
    'compare_entities': '实体对比',
    'aggregate_statistics': '统计聚合',
    'get_spatial_neighbors': '空间邻近查询',
    'get_graph_schema': '图谱结构查询'
  };
  return nameMap[toolName] || toolName;
}

// 获取工具标签
function getToolLabel(toolName) {
  const labels = {
    'query_knowledge_graph_with_nl': 'NL查询',
    'search_knowledge_graph': '搜索',
    'analyze_temporal_pattern': '时序',
    'find_causal_chain': '因果',
    'compare_entities': '对比',
    'aggregate_statistics': '统计',
    'get_spatial_neighbors': '空间'
  };
  return labels[toolName] || '工具';
}

// 获取工具颜色
function getToolColor(toolName) {
  const colorMap = {
    'query_knowledge_graph_with_nl': '#409eff',
    'search_knowledge_graph': '#67c23a',
    'analyze_temporal_pattern': '#e6a23c',
    'find_causal_chain': '#f56c6c',
    'compare_entities': '#909399',
    'aggregate_statistics': '#5cb87a'
  };
  return colorMap[toolName] || '#409eff';
}

// 格式化工具参数
function formatToolArgs(args) {
  if (!args) return {};
  const formatted = {};
  for (const [key, val] of Object.entries(args)) {
    if (Array.isArray(val)) {
      formatted[key] = val.join(', ');
    } else if (typeof val === 'object') {
      formatted[key] = JSON.stringify(val);
    } else {
      formatted[key] = String(val).substring(0, 50);
    }
  }
  return formatted;
}

// 判断工具是否有数据
function hasToolData(tool) {
  if (!tool.result || !tool.result.data) return false;
  const data = tool.result.data;
  return !!(data.cypher || data.query_results || data.results || data.records || data.graph_data || data.graph);
}

// 获取工具数据类型标签
function getToolDataType(tool) {
  if (!tool.result || !tool.result.success) return 'danger';
  const data = tool.result.data;
  if (data.graph_data || data.graph) return 'success';
  if (data.cypher) return 'primary';
  return 'info';
}

// 获取工具数据摘要
function getToolDataSummary(tool) {
  if (!tool.result || !tool.result.data) return '';
  const data = tool.result.data;
  
  const parts = [];
  if (data.cypher) parts.push('Cypher');
  if (data.query_results || data.results || data.records) {
    const count = (data.query_results || data.results || data.records).length;
    parts.push(`${count}条结果`);
  }
  if (data.graph_data || data.graph) {
    const graph = data.graph_data || data.graph;
    const nodeCount = graph.nodes?.length || 0;
    if (nodeCount > 0) parts.push(`${nodeCount}节点`);
  }
  
  return parts.join(' / ') || '已完成';
}

// 获取工具的查询结果
function getToolResults(tool) {
  if (!tool.result || !tool.result.data) return [];
  const data = tool.result.data;
  return data.query_results || data.results || data.records || [];
}

// 获取工具的图谱数据
function getToolGraphData(tool) {
  if (!tool.result || !tool.result.data) return null;
  const data = tool.result.data;
  return data.graph_data || data.graph || null;
}

// 复制 Cypher
function copyCypher(cypher) {
  copyToClipboard(cypher);
}

// 复制文本
function copyText(text) {
  // 移除HTML标签
  const div = document.createElement('div');
  div.innerHTML = text;
  const plainText = div.textContent || div.innerText || text;
  copyToClipboard(plainText);
}

// 通用复制函数
function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('已复制到剪贴板');
    }).catch(() => {
      ElMessage.error('复制失败');
    });
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    ElMessage.success('已复制到剪贴板');
  }
}

// 获取消息关联的工具调用
function getMessageTools(messageIndex) {
  return messageToolsMap.value[messageIndex] || [];
}

// 切换消息推理过程展开状态
function toggleMessageTools(messageIndex) {
  expandedMessageTools.value[messageIndex] = !expandedMessageTools.value[messageIndex];
}

// 检查消息推理过程是否展开
function isMessageToolsExpanded(messageIndex) {
  return expandedMessageTools.value[messageIndex] !== false; // 默认展开
}

// 获取消息关联的图表
function getMessageChart(messageIndex) {
  return messageChartsMap.value[messageIndex] || null;
}

// 从工具调用中提取图表数据
function extractChartFromTools(toolCalls) {
  if (!toolCalls || !Array.isArray(toolCalls)) return null;
  
  // 查找 generate_chart 工具调用
  const chartTool = toolCalls.find(tool => tool.name === 'generate_chart');
  if (!chartTool || !chartTool.result || !chartTool.result.success) return null;
  
  const result = chartTool.result;
  if (result.echarts_config && result.chart_type) {
    return {
      echarts_config: result.echarts_config,
      chart_type: result.chart_type,
      data_summary: result.data_summary || {}
    };
  }
  
  return null;
}

// 格式化时间
function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// 滚动到底部
function scrollToBottom() {
  if (chatScrollbar.value) {
    const scrollEl = chatScrollbar.value.$refs.wrap$;
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }
}

async function sendQuestion() {
  if (!question.value || loading.value) return;
  
  const userMessage = {
    role: 'user',
    content: question.value,
    timestamp: new Date()
  };
  messages.value.push(userMessage);
  
  // 滚动到底部
  nextTick(() => {
    scrollToBottom();
  });
  
  loading.value = true;
  try {
    const resp = await graphragService.queryGraphRAG(question.value, messages.value);
    console.log('=== API 完整响应 ===', resp);
    
    if (resp && resp.success) {
      const d = resp.data;
      console.log('=== 响应数据 ===', d);
      
      // AI回答
      if (d.answer) {
        const assistantMessage = {
          role: 'assistant',
          content: d.answer,
          timestamp: new Date()
        };
        messages.value.push(assistantMessage);
        
        // 关联工具调用到这条消息
        if (d.tool_calls && d.tool_calls.length > 0) {
          messageToolsMap.value[messages.value.length - 1] = d.tool_calls;
          
          // 提取图表数据
          const chartData = extractChartFromTools(d.tool_calls);
          if (chartData) {
            messageChartsMap.value[messages.value.length - 1] = chartData;
            console.log('✅ 提取到图表数据');
          }
        }
        
        // 滚动到底部
        nextTick(() => {
          scrollToBottom();
        });
      }
      
      // 初始化
      lastCypher.value = '';
      lastResults.value = [];
      
      // 工具调用
      if (d.tool_calls && Array.isArray(d.tool_calls)) {
        toolCalls.value = d.tool_calls;
        console.log('✅ 工具调用已提取:', toolCalls.value.length, '个');
        
        // 从工具调用结果中提取 Cypher、查询结果和图谱数据
        let allGraphData = { nodes: [], relationships: [] };
        let allResults = [];
        
        d.tool_calls.forEach((toolCall, idx) => {
          console.log(`--- 工具 ${idx + 1}: ${toolCall.name} ---`);
          
          if (toolCall.result && toolCall.result.success && toolCall.result.data) {
            const toolData = toolCall.result.data;
            
            // 提取 Cypher（如果有）
            if (toolData.cypher && !lastCypher.value) {
              lastCypher.value = toolData.cypher;
              console.log('✅ 从工具结果提取 Cypher');
            }
            
            // 提取查询结果
            if (toolData.query_results && Array.isArray(toolData.query_results)) {
              allResults = allResults.concat(toolData.query_results);
              console.log(`✅ 从工具提取 ${toolData.query_results.length} 条结果`);
            } else if (toolData.results && Array.isArray(toolData.results)) {
              allResults = allResults.concat(toolData.results);
              console.log(`✅ 从工具提取 ${toolData.results.length} 条结果`);
            } else if (toolData.records && Array.isArray(toolData.records)) {
              allResults = allResults.concat(toolData.records);
              console.log(`✅ 从工具提取 ${toolData.records.length} 条记录`);
            }
            
            // 提取图谱数据
            if (toolData.graph_data) {
              if (toolData.graph_data.nodes) {
                allGraphData.nodes = allGraphData.nodes.concat(toolData.graph_data.nodes);
              }
              if (toolData.graph_data.relationships) {
                allGraphData.relationships = allGraphData.relationships.concat(toolData.graph_data.relationships);
              }
              console.log(`✅ 从工具提取图谱: ${toolData.graph_data.nodes?.length || 0} 节点`);
            } else if (toolData.graph) {
              if (toolData.graph.nodes) {
                allGraphData.nodes = allGraphData.nodes.concat(toolData.graph.nodes);
              }
              if (toolData.graph.relationships) {
                allGraphData.relationships = allGraphData.relationships.concat(toolData.graph.relationships);
              }
              console.log(`✅ 从工具提取图谱: ${toolData.graph.nodes?.length || 0} 节点`);
            }
          }
        });
        
        // 设置查询结果
        if (allResults.length > 0) {
          lastResults.value = allResults;
          console.log('✅ 总计查询结果:', allResults.length, '条');
        }
        
        // 设置图谱数据
        if (allGraphData.nodes.length > 0) {
          console.log('=== 合并后的图谱数据 ===', {
            nodes: allGraphData.nodes.length,
            relationships: allGraphData.relationships.length
          });
          
          graphData.value = extractGraphData(allGraphData);
          console.log('✅ 图谱已提取:', graphData.value.nodes.length, '节点,', graphData.value.links.length, '关系');
          
          if (graphData.value.nodes.length > 0) {
            nextTick(() => {
              setTimeout(() => {
                renderGraph();
              }, 100);
            });
          }
        } else {
          console.warn('⚠️ 未从工具调用中提取到图谱数据');
          graphData.value = { nodes: [], links: [] };
        }
        
      } else {
        console.warn('⚠️ 未找到tool_calls字段');
        toolCalls.value = [];
        graphData.value = { nodes: [], links: [] };
      }
      
    } else {
      const errMsg = (resp && resp.message) || '未知错误';
      messages.value.push({ role: 'assistant', content: '请求失败：' + errMsg });
      console.error('请求失败:', resp);
    }
  } catch (e) {
    console.error('请求错误:', e);
    messages.value.push({ role: 'assistant', content: '请求出错：' + String(e) });
  } finally {
    loading.value = false;
    question.value = '';
  }
}

async function fetchSchema() {
  try {
    const resp = await graphragService.getGraphSchema();
    if (resp && resp.data && resp.data.success) {
      schema.value = resp.data.data;
      activeNames.value = ['3'];
    } else {
      schema.value = { error: (resp.data && resp.data.message) || '获取失败' };
    }
  } catch (e) {
    schema.value = { error: String(e) };
  }
}

function clear() {
  question.value = '';
  messages.value = [];
  lastCypher.value = '';
  lastResults.value = [];
  schema.value = null;
  toolCalls.value = [];
  messageToolsMap.value = {};
  expandedMessageTools.value = {};
  graphData.value = { nodes: [], links: [] };
  if (graphInstance && graphContainer.value) {
    graphContainer.value.innerHTML = '';
    graphInstance = null;
  }
}

function formatContent(text) {
  if (!text) return '';
  
  try {
    // 使用 marked 解析 Markdown
    const rawHtml = marked.parse(text);
    // 使用 DOMPurify 清理 HTML，防止 XSS 攻击
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'u', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
      ALLOWED_ATTR: ['href', 'target', 'rel']
    });
    return cleanHtml;
  } catch (e) {
    // 如果解析失败，使用简单的文本处理
    return text.replace(/\n/g, '<br/>');
  }
}
</script>


<style scoped>
/* 容器 */
.graphrag-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f0f2f5;
  overflow: hidden;
}

/* 主内容区 - 2列布局 */
.main-content {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.chat-column,
.right-column {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-column {
  flex: 1;
  min-width: 0;
  background: white;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.right-column {
  flex: 0 0 380px;
  background: white;
  border-left: 1px solid #e4e7ed;
  overflow-y: auto;
  position: relative;
  transition: all 0.3s ease;
}

.right-column.collapsed {
  flex: 0 0 0;
  min-width: 0;
  border: none;
  overflow: hidden;
}

.sidebar-toggle {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 80px;
  background: white;
  border: 1px solid #e4e7ed;
  border-right: none;
  border-radius: 8px 0 0 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 100;
  box-shadow: -2px 0 8px rgba(0,0,0,0.06);
  transition: all 0.3s ease;
}

.sidebar-toggle:hover {
  background: #f5f7fa;
}

.sidebar-toggle .el-icon {
  font-size: 18px;
  color: #606266;
}

.right-column:not(.collapsed) .sidebar-toggle {
  right: 380px;
}

.collapsed .sidebar-toggle {
  right: 0;
}

.sidebar-content {
  height: 100%;
  overflow-y: auto;
}

/* 详情折叠面板 */
.detail-collapse {
  border: none;
}

.detail-collapse :deep(.el-collapse-item__header) {
  padding: 16px;
  background: #fafbfc;
  border-bottom: 1px solid #e4e7ed;
  font-weight: 600;
  font-size: 14px;
  color: #303133;
}

.detail-collapse :deep(.el-collapse-item__wrap) {
  border-bottom: 1px solid #e4e7ed;
}

.detail-collapse :deep(.el-collapse-item__content) {
  padding: 0;
}

/* 对话区 */
.chat-scrollbar {
  flex: 1;
  min-height: 0;
}

/* 输入区 */
.chat-input-section {
  flex-shrink: 0;
  padding: 16px 20px 20px 20px;
  background: transparent;
  border-top: none;
}

.input-container {
  max-width: 900px;
  margin: 0 auto;
}

/* 示例快捷按钮 */
.example-chips {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.example-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 20px;
  font-size: 13px;
  color: #606266;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.example-chip:hover {
  background: #ecf5ff;
  border-color: #409eff;
  color: #409eff;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.15);
}

.example-chip .el-icon {
  font-size: 14px;
}

/* 输入框容器 */
.input-wrapper {
  width: 100%;
}

.input-box {
  display: flex;
  position: relative;
  background: white;
  border: 2px solid #e4e7ed;
  border-radius: 24px;
  padding: 12px 16px;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  align-items: center;
}

.input-box:hover {
  border-color: #c0c4cc;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.input-box.focused {
  border-color: #667eea;
  box-shadow: 0 4px 16px rgba(102, 126, 234, 0.15);
}

.input-box.hasContent {
  border-color: #909399;
}

/* 文本输入框 */
.message-input {
  width: 100%;
  min-height: 24px;
  max-height: 200px;
  padding: 0;
  border: none;
  outline: none;
  resize: none;
  font-size: 15px;
  line-height: 24px;
  color: #303133;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  background: transparent;
  overflow-y: auto;
}

.message-input::placeholder {
  color: #c0c4cc;
}

.message-input:disabled {
  color: #c0c4cc;
  cursor: not-allowed;
}

/* 滚动条样式 */
.message-input::-webkit-scrollbar {
  width: 6px;
}

.message-input::-webkit-scrollbar-track {
  background: transparent;
}

.message-input::-webkit-scrollbar-thumb {
  background: #dcdfe6;
  border-radius: 3px;
}

.message-input::-webkit-scrollbar-thumb:hover {
  background: #c0c4cc;
}

/* 操作按钮区 */
.input-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  /* margin-top: 8px; */
  justify-content: flex-end;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: all 0.2s ease;
  outline: none;
}

.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: #909399;
}

.icon-btn:hover {
  background: #f5f7fa;
  color: #606266;
}

.icon-btn:active {
  transform: scale(0.95);
}

.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #e4e7ed;
  color: white;
  font-size: 18px;
}

.send-btn.active {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

.send-btn.active:hover {
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  transform: scale(1.05);
}

.send-btn.active:active {
  transform: scale(0.95);
}

.send-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* 提示信息 */
.input-hint {
  margin-top: 8px;
  text-align: center;
}

.hint-text {
  font-size: 12px;
  color: #c0c4cc;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.hint-text kbd {
  padding: 2px 6px;
  background: #f5f7fa;
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  font-size: 11px;
  font-family: monospace;
  color: #606266;
}

.hint-divider {
  margin: 0 4px;
  color: #dcdfe6;
}

/* 示例菜单 */
.examples-menu {
  max-height: 400px;
  overflow-y: auto;
}

.menu-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f2f5;
}

.menu-item {
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 4px;
}

.menu-item:hover {
  background: #f5f7fa;
}

.item-label {
  font-size: 14px;
  color: #303133;
  margin-bottom: 4px;
}

.item-type {
  font-size: 12px;
  color: #909399;
}

.chat-container {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
}

/* 欢迎消息 */
.welcome-message {
  text-align: center;
  padding: 80px 20px;
  color: #606266;
}

.welcome-icon {
  margin-bottom: 24px;
  color: #909399;
}

.welcome-message h2 {
  margin: 0 0 8px 0;
  font-size: 28px;
  font-weight: 600;
  color: #303133;
}

.welcome-message > p {
  margin: 0 0 32px 0;
  font-size: 15px;
  color: #909399;
}

.welcome-hints {
  display: flex;
  gap: 24px;
  justify-content: center;
  margin-top: 32px;
}

.hint-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  background: #f8f9fa;
  border-radius: 8px;
  min-width: 100px;
}

.hint-item .el-icon {
  font-size: 24px;
  color: #667eea;
}

.hint-item span {
  font-size: 13px;
  color: #606266;
  font-weight: 500;
}

/* 消息流 */
.messages-flow {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.message-item {
  display: flex;
  animation: fadeIn 0.3s ease-in;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message-content {
  display: flex;
  gap: 12px;
  max-width: 100%;
}

.message-avatar {
  flex-shrink: 0;
  margin-top: 4px;
}

.message-bubble {
  flex: 1;
  min-width: 0;
}

/* 用户消息 */
.user-message {
  justify-content: flex-end;
}

.user-message .message-content {
  flex-direction: row-reverse;
}

.user-bubble {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 12px 16px;
  border-radius: 18px 18px 4px 18px;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
  max-width: 70%;
}

.user-bubble .message-text {
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

/* AI 消息 */
.assistant-message {
  justify-content: flex-start;
}

.assistant-bubble {
  background: #f8f9fa;
  padding: 16px;
  border-radius: 4px 18px 18px 18px;
  border: 1px solid #e4e7ed;
  max-width: 100%;
}

/* 工具调用部分 */
.tool-calls-section {
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #e4e7ed;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: #606266;
  background: #fafbfc;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  transition: all 0.2s ease;
}

.section-header:hover {
  background: #f0f2f5;
}

.toggle-icon {
  margin-left: auto;
  transition: transform 0.3s ease;
}

.toggle-icon.expanded {
  transform: rotate(180deg);
}

.tool-calls-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  animation: slideDown 0.3s ease;
}

@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.tool-call-card {
  background: white;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: #fafbfc;
  border-bottom: 1px solid #e4e7ed;
}

.tool-step {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-badge {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #667eea;
  color: white;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tool-name {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.tool-details-collapse {
  border: none;
}

.tool-details-collapse :deep(.el-collapse-item__header) {
  padding: 8px 12px;
  border: none;
  background: transparent;
  height: auto;
  line-height: 1.5;
}

.tool-details-collapse :deep(.el-collapse-item__wrap) {
  border: none;
}

.tool-details-collapse :deep(.el-collapse-item__content) {
  padding: 0 12px 12px 12px;
}

.collapse-trigger {
  font-size: 12px;
  color: #409eff;
  display: flex;
  align-items: center;
  gap: 4px;
}

.tool-detail-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-block {
  background: #f8f9fa;
  padding: 10px;
  border-radius: 6px;
}

.block-label {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.param-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.code-block {
  margin: 0;
  padding: 10px;
  background: #282c34;
  color: #abb2bf;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  font-family: 'Consolas', 'Monaco', monospace;
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.results-preview {
  font-size: 11px;
  font-family: 'Consolas', 'Monaco', monospace;
  color: #606266;
  white-space: pre-wrap;
  max-height: 150px;
  overflow-y: auto;
}

.more-indicator {
  display: block;
  margin-top: 8px;
  color: #909399;
  font-style: italic;
}

.graph-stats {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: #606266;
}

.graph-stats span {
  padding: 4px 10px;
  background: white;
  border-radius: 4px;
  border: 1px solid #e4e7ed;
}

/* 答案部分 */
.answer-section {
  margin-bottom: 12px;
}

.answer-section .message-text {
  font-size: 14px;
  line-height: 1.8;
  color: #303133;
}

/* 图表部分 */
.chart-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px dashed #e4e7ed;
}

/* 消息元信息 */
.message-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid #f0f2f5;
  margin-top: 8px;
}

.meta-time {
  font-size: 11px;
  color: #c0c4cc;
}

/* 加载动画 */
.typing-indicator {
  display: flex;
  gap: 6px;
  padding: 8px 0;
}

.typing-indicator span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #909399;
  animation: typing 1.4s infinite;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.2s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes typing {
  0%, 60%, 100% {
    opacity: 0.3;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-10px);
  }
}



/* 推理过程内容 */
.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 2px 0;
}

.collapse-body {
  padding: 16px;
}

.tool-steps-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tool-step-item {
  background: white;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  overflow: hidden;
}

.step-header-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: #fafbfc;
  border-bottom: 1px solid #e4e7ed;
}

.step-details-expandable {
  background: white;
}

.step-details-expandable .el-collapse {
  border: none;
}

.step-details-expandable :deep(.el-collapse-item__header) {
  padding: 10px 12px;
  background: transparent;
  border-bottom: 1px solid #f5f7fa;
  height: auto;
  line-height: 1.5;
  font-size: 13px;
}

.step-details-expandable :deep(.el-collapse-item__wrap) {
  border: none;
  background: #fafbfc;
}

.step-details-expandable :deep(.el-collapse-item__content) {
  padding: 12px;
}

.detail-item-title {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: #606266;
}

.graph-data-preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.step-index-inline {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #409eff;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.step-name-inline {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  flex: 1;
}

.step-details {
  padding: 8px 0;
}

.detail-section {
  margin-bottom: 12px;
}

.detail-section:last-child {
  margin-bottom: 0;
}

.detail-label {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.detail-content {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.code-display-inline {
  margin: 0;
  padding: 8px;
  background: #282c34;
  color: #abb2bf;
  border-radius: 4px;
  font-size: 11px;
  line-height: 1.5;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

/* 汇总统计 */
.summary-stats {
  padding: 4px 0;
}

/* 技术详情 */
.collapse-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  flex: 1;
}

.collapse-body {
  padding: 16px;
  max-height: 400px;
  overflow-y: auto;
}

.code-display {
  margin: 0;
  padding: 12px;
  background: #282c34;
  color: #abb2bf;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Markdown 样式 */
.message-text :deep(h1),
.message-text :deep(h2),
.message-text :deep(h3),
.message-text :deep(h4) {
  margin: 16px 0 12px 0;
  font-weight: 600;
  color: #303133;
  line-height: 1.4;
}

.message-text :deep(h1) { font-size: 1.5em; }
.message-text :deep(h2) { font-size: 1.35em; }
.message-text :deep(h3) { font-size: 1.2em; }
.message-text :deep(h4) { font-size: 1.1em; }

.message-text :deep(p) {
  margin: 8px 0;
  line-height: 1.8;
}

.message-text :deep(code) {
  background: #e7f3ff;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 0.9em;
  color: #1890ff;
}

.message-text :deep(pre) {
  background: #282c34;
  color: #abb2bf;
  padding: 14px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 12px 0;
}

.message-text :deep(pre code) {
  background: none;
  padding: 0;
  color: #abb2bf;
}

.message-text :deep(ul),
.message-text :deep(ol) {
  margin: 10px 0;
  padding-left: 28px;
}

.message-text :deep(li) {
  margin: 6px 0;
  line-height: 1.8;
}

.message-text :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
  font-size: 13px;
}

.message-text :deep(th),
.message-text :deep(td) {
  border: 1px solid #e4e7ed;
  padding: 10px 12px;
  text-align: left;
}

.message-text :deep(th) {
  background: #f5f7fa;
  font-weight: 600;
  color: #303133;
}

.message-text :deep(strong) {
  font-weight: 600;
  color: #303133;
}

.message-text :deep(blockquote) {
  border-left: 4px solid #667eea;
  padding-left: 16px;
  margin: 12px 0;
  color: #606266;
  font-style: italic;
}

.message-text :deep(a) {
  color: #409eff;
  text-decoration: none;
}

.message-text :deep(a:hover) {
  text-decoration: underline;
}

/* 滚动条 */
/* .chat-scrollbar:deep(.el-scrollbar__wrap),
.collapse-body {
  scrollbar-width: thin;
  scrollbar-color: #c0c4cc #f5f7fa;
} */

.chat-scrollbar:deep(.el-scrollbar__wrap)::-webkit-scrollbar,
.collapse-body::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.chat-scrollbar:deep(.el-scrollbar__wrap)::-webkit-scrollbar-thumb,
.collapse-body::-webkit-scrollbar-thumb {
  background: #c0c4cc;
  border-radius: 3px;
}

.chat-scrollbar:deep(.el-scrollbar__wrap)::-webkit-scrollbar-track,
.collapse-body::-webkit-scrollbar-track {
  background: #f5f7fa;
}

/* 响应式 */
@media (max-width: 1400px) {
  .right-column {
    flex: 0 0 380px;
  }
}

@media (max-width: 1200px) {
  .main-content {
    flex-direction: column;
  }
  
  .chat-column,
  .right-column {
    flex: none;
    width: 100%;
    border: none;
  }
  
  .chat-column {
    flex: 1;
    min-height: 0;
  }
  
  .right-column {
    max-height: 300px;
    border-top: 1px solid #e4e7ed;
    border-left: none;
  }
  
  .right-column.collapsed {
    flex: 0 0 0;
    max-height: 0;
  }
  
  .sidebar-toggle {
    left: auto;
    right: 0;
    top: auto;
    bottom: 60px;
    transform: none;
    width: 80px;
    height: 32px;
    border-radius: 8px 8px 0 0;
    border-bottom: none;
    border-right: 1px solid #e4e7ed;
  }
  
  .right-column:not(.collapsed) .sidebar-toggle {
    right: 0;
  }
  
  .collapsed .sidebar-toggle {
    right: 0;
  }
  
  .user-bubble {
    max-width: 85%;
  }
}

@media (max-width: 768px) {
  .chat-container {
    padding: 12px;
  }
  
  .welcome-message {
    padding: 40px 12px;
  }
  
  .welcome-hints {
    flex-direction: column;
    gap: 12px;
  }
  
  .user-bubble {
    max-width: 90%;
  }
  
  .message-content {
    gap: 8px;
  }
  
  .input-row {
    flex-wrap: wrap;
  }
  
  .input-row .el-select {
    width: 100% !important;
  }
  
  .chat-input-section {
    padding: 12px;
  }
  
  .example-chips {
    flex-direction: column;
  }
  
  .example-chip {
    width: 100%;
    justify-content: center;
  }
  
  .input-box {
    border-radius: 20px;
    padding: 10px 14px;
  }
  
  .message-input {
    font-size: 14px;
  }
  
  .input-actions {
    margin-top: 6px;
  }
  
  .right-column {
    max-height: 250px;
  }
}
</style>
