<template>
  <div class="execution-dag vertical">
    <svg :width="svgWidth" :height="svgHeight" class="dag-svg">
      <!-- 绘制连接线 -->
      <g class="edges">
        <!-- 线条 -->
        <path
          v-for="(edge, index) in edges"
          :key="`edge-path-${index}`"
          :d="edge.path"
          class="edge-path"
          :class="{ 'edge-dashed': edge.dashed }"
        />
        <!-- 手动绘制箭头 -->
        <path
          v-for="(edge, index) in edges"
          :key="`edge-arrow-${index}`"
          :d="edge.arrowPath"
          class="edge-arrow"
          :class="{ 'edge-arrow-dashed': edge.dashed }"
        />
      </g>

      <!-- 绘制节点 -->
      <g class="nodes">
        <g
          v-for="node in nodes"
          :key="node.id"
          :transform="`translate(${node.x}, ${node.y})`"
          class="node"
          :class="node.type"
        >
          <!-- 使用 foreignObject 嵌入 HTML -->
          <foreignObject
            :width="node.width"
            :height="node.height"
            style="overflow: visible;"
          >
            <!-- 仅显示图标，圆形节点 -->
            <div class="node-circle" :class="[node.type, { 'has-error': node.status === 'error' }]" :title="node.label">
               <span class="node-icon">{{ node.icon }}</span>
               <div v-if="node.status === 'running'" class="node-spinner"></div>
               <!-- R1, R2 徽章 -->
               <div v-if="node.type === 'master' && node.round" class="node-badge-circle">R{{ node.round }}</div>
            </div>
          </foreignObject>
        </g>
      </g>
    </svg>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';

const props = defineProps({
  subtasks: {
    type: Array,
    required: true
  },
  finished: {
    type: Boolean,
    default: false
  },
  cardPositions: {
    type: Array,
    default: () => []
  }
});

// 垂直布局配置
const nodeSize = 40; // 圆形节点直径
const xOffset = 20;  // 左侧 padding
const yStart = 20;   // 顶部 padding
const stepHeight = 120; // 默认间距（当没有 cardPositions 时使用）
const padding = 24; // 底部 padding

// 构建 DAG 节点 (垂直布局，支持动态位置)
const nodes = computed(() => {
  const result = [];
  let currentY = yStart;

  // 如果有 cardPositions，使用实际位置；否则使用估算值
  const useCardPositions = props.cardPositions && props.cardPositions.length > 0;
  let posIndex = 0;

  // 按轮次分组
  const roundGroups = {};
  props.subtasks.forEach(subtask => {
    const round = subtask.round || 1;
    if (!roundGroups[round]) {
      roundGroups[round] = [];
    }
    roundGroups[round].push(subtask);
  });

  const rounds = Object.keys(roundGroups).sort((a, b) => Number(a) - Number(b));

  // 遍历所有轮次和 Agents
  rounds.forEach((round, roundIndex) => {
    const agents = roundGroups[round];

    // Agents 节点 (垂直排列)
    agents.forEach((agent, agentIndex) => {
      if (useCardPositions && props.cardPositions[posIndex]) {
        currentY = props.cardPositions[posIndex].y || currentY;
        posIndex++;
      }

      result.push({
        id: `agent-${agent.order}`,
        type: 'agent',
        label: agent.agent_display_name || agent.agent_name,
        icon: '🤖',
        x: xOffset,
        y: currentY,
        width: nodeSize,
        height: nodeSize,
        order: agent.order,
        round: agent.round,
        status: agent.status
      });

      if (!useCardPositions) {
        currentY += stepHeight;
      }
    });
  });

  return result;
});

// 构建 DAG 边 (垂直连接)
const edges = computed(() => {
  const result = [];
  const roundGroups = {};
  props.subtasks.forEach(subtask => {
    const round = subtask.round || 1;
    if (!roundGroups[round]) {
      roundGroups[round] = [];
    }
    roundGroups[round].push(subtask);
  });
  const rounds = Object.keys(roundGroups).sort((a, b) => Number(a) - Number(b));

  // Master Start → 第一轮 Agents (第一个)
  const firstRoundAgents = roundGroups[rounds[0]] || [];
  if (firstRoundAgents.length > 0) {
     const fromNode = nodes.value.find(n => n.id === 'master-start');
     const toNode = nodes.value.find(n => n.id === `agent-${firstRoundAgents[0].order}`);
     if (fromNode && toNode) {
       result.push(createVerticalEdge(fromNode, toNode));
     }
  }

  // 连接每一行的节点
  // 逻辑简化：直接按 Y 轴排序连接相邻节点即可，因为现在是单列布局
  // 但为了保留逻辑语义，还是按 master -> agent -> agent ... -> master 连接

  // 辅助函数：按顺序连接
  const connectSequential = () => {
      // 获取所有节点并按 Y 坐标排序
      const sortedNodes = [...nodes.value].sort((a, b) => a.y - b.y);
      for (let i = 0; i < sortedNodes.length - 1; i++) {
          const from = sortedNodes[i];
          const to = sortedNodes[i+1];
          // 如果是 next-step 且是 dashed，需要特殊处理（在 createVerticalEdge 内部判断）
          const isDashed = to.id === 'next-step';
          result.push({
              ...createVerticalEdge(from, to),
              dashed: isDashed
          });
      }
  };
  connectSequential();

  return result;
});

// 创建垂直边的路径
const createVerticalEdge = (fromNode, toNode) => {
  const x = fromNode.x + fromNode.width / 2;
  const y1 = fromNode.y + fromNode.height;
  const y2 = toNode.y;

  // 垂直直线
  const path = `M ${x} ${y1} L ${x} ${y2}`;

  // 箭头尺寸
  const arrowLength = 6;
  const arrowWidth = 4;

  // 箭头路径 (向下)
  // M (尖端) L (左上) L (凹陷) L (右上) Z
  const arrowY = y2;
  const arrowPath = `M ${x} ${arrowY} L ${x - arrowWidth} ${arrowY - arrowLength} L ${x} ${arrowY - arrowLength + 2} L ${x + arrowWidth} ${arrowY - arrowLength} Z`;

  return { path, arrowPath };
};

const svgWidth = computed(() => nodeSize + xOffset * 2);
const svgHeight = computed(() => {
    if (nodes.value.length === 0) return 0;
    const lastNode = nodes.value[nodes.value.length - 1];
    return lastNode.y + lastNode.height + padding;
});

</script>

<style scoped>
.execution-dag.vertical {
  width: 80px; /* 固定宽度 */
  flex-shrink: 0;
  background: transparent; /* 透明背景 */
  border: none;
  padding: 0;
  margin: 0;
  height: 100%; /* 充满父容器 */
  overflow: visible; /* 允许 svg 溢出 */
}

.dag-svg {
  display: block;
  overflow: visible;
}

/* 边 */
.edge-path {
  fill: none;
  stroke: var(--color-interactive);
  stroke-width: 2;
  opacity: 0.4;
}

.edge-dashed {
  stroke-dasharray: 6, 4;
}

.edge-arrow {
  fill: var(--color-interactive);
  opacity: 0.4;
}

.edge-arrow-dashed {
  opacity: 0.3;
}

/* 节点圆形样式 */
.node-circle {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--color-bg-secondary);
  border: 2px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  transition: all 0.2s;
  cursor: pointer;
  box-sizing: border-box;
}

.node-circle:hover {
  transform: scale(1.1);
  border-color: var(--color-interactive);
  z-index: 10;
}

.node-circle.master {
  background: var(--color-bg-primary);
  border-color: var(--color-interactive);
}

.node-circle.final {
  background: var(--color-success-bg);
  border-color: var(--color-success);
}

.node-circle.pending {
  border-style: dashed;
  border-color: var(--color-interactive);
  opacity: 0.7;
}

.node-circle.has-error {
  border-color: var(--color-error);
  background: var(--color-error-bg);
}

.node-icon {
  font-size: 18px;
  line-height: 1;
}

/* Badge */
.node-badge-circle {
  position: absolute;
  bottom: -4px;
  right: -4px;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: var(--color-interactive);
  padding: 1px 4px;
  border-radius: 8px;
  border: 1px solid var(--color-bg-primary);
}

/* 加载动画 */
.node-spinner {
  position: absolute;
  top: -2px;
  left: -2px;
  right: -2px;
  bottom: -2px;
  border-radius: 50%;
  border: 2px solid transparent;
  border-top-color: var(--color-interactive);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 深色主题适配 */
:root[data-theme="dark"] .node-circle {
  background: #1e293b;
}
:root[data-theme="dark"] .node-circle.master {
  background: #1e1b4b;
}
</style>
