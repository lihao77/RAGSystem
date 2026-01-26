<template>
  <div v-if="shouldShow" class="execution-plan-card">
    <div class="card-header">
      <span class="card-title">📊 任务依赖关系</span>
      <span class="mode-badge" :class="plan.mode">{{ getModeText(plan.mode) }}</span>
      <span class="subtask-count">{{ plan.subtasks.length }} 个任务</span>
    </div>

    <div class="card-content">
      <!-- DAG 可视化 -->
      <div v-if="showDagVisualization" class="dag-container">
        <div class="dag-canvas" ref="dagCanvas">
            <!-- 节点 -->
            <div
              v-for="node in layoutNodes"
              :key="node.id"
              class="dag-node"
              :class="[node.status, { parallel: node.isParallel }]"
              :style="{
                left: node.x + 'px',
                top: node.y + 'px'
              }"
            >
              <div class="node-content">
                <div class="node-order">{{ node.order }}</div>
                <div class="node-label">{{ node.label }}</div>
                <div class="node-status-icon">{{ getStatusIcon(node.status) }}</div>
              </div>
            </div>

            <!-- 边（连接线） -->
            <svg class="dag-edges" :style="{ width: canvasWidth + 'px', height: canvasHeight + 'px' }">
              <defs>
                <marker
                  id="arrowhead"
                  markerWidth="10"
                  markerHeight="10"
                  refX="9"
                  refY="3"
                  orient="auto"
                >
                  <polygon points="0 0, 10 3, 0 6" fill="var(--color-border)" />
                </marker>
              </defs>
              <path
                v-for="(edge, index) in layoutEdges"
                :key="index"
                :d="edge.path"
                class="dag-edge"
                :class="{ active: edge.active }"
                marker-end="url(#arrowhead)"
              />
            </svg>
          </div>
        </div>

      <!-- 任务列表（简洁模式 - 不显示 DAG 时） -->
      <div v-else class="task-list">
        <div
          v-for="subtask in plan.subtasks"
          :key="subtask.id"
          class="task-item"
          :class="subtask.status"
        >
          <span class="task-order">{{ subtask.order }}</span>
          <span class="task-desc">{{ subtask.description }}</span>
          <span class="task-agent">{{ subtask.agent_name }}</span>
          <span class="task-status">{{ getStatusIcon(subtask.status) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';

const props = defineProps({
  plan: {
    type: Object,
    required: true
  }
});

const dagCanvas = ref(null);
const canvasWidth = ref(600);
const canvasHeight = ref(400);

const shouldShow = computed(() => {
  return props.plan && props.plan.subtasks && props.plan.subtasks.length > 0;
});

const showDagVisualization = computed(() => {
  // 只有在并行或 DAG 模式下显示可视化
  return ['parallel', 'dag'].includes(props.plan.mode) && props.plan.subtasks.length > 1;
});

const getModeText = (mode) => {
  const modeMap = {
    'simple': '单任务',
    'sequential': '顺序执行',
    'parallel': '并行执行',
    'dag': 'DAG 执行'
  };
  return modeMap[mode] || mode;
};

const getStatusIcon = (status) => {
  const iconMap = {
    'pending': '⏸️',
    'ready': '▶️',
    'running': '⏳',
    'completed': '✅',
    'failed': '❌',
    'skipped': '⏭️'
  };
  return iconMap[status] || '⚪';
};

// DAG 布局计算
const layoutNodes = computed(() => {
  if (!props.plan.dag || !props.plan.dag.nodes) return [];

  const nodes = props.plan.dag.nodes;
  const edges = props.plan.dag.edges || [];

  // 按层次分组（拓扑排序）
  const layers = calculateLayers(nodes, edges);

  const nodeWidth = 120;
  const nodeHeight = 70;
  const layerSpacing = 140;
  const nodeSpacing = 80;

  const layoutedNodes = [];

  layers.forEach((layer, layerIndex) => {
    const layerWidth = layer.length * nodeWidth + (layer.length - 1) * nodeSpacing;
    const startX = (canvasWidth.value - layerWidth) / 2;

    layer.forEach((nodeId, nodeIndex) => {
      const node = nodes.find(n => n.id === nodeId);
      if (node) {
        const x = startX + nodeIndex * (nodeWidth + nodeSpacing);
        const y = 30 + layerIndex * layerSpacing;

        // 检查是否是并行节点（同一层的其他节点）
        const isParallel = layer.length > 1;

        layoutedNodes.push({
          ...node,
          x,
          y,
          isParallel
        });
      }
    });
  });

  // 更新画布高度
  canvasHeight.value = Math.max(300, 30 + layers.length * layerSpacing + 50);

  return layoutedNodes;
});

const layoutEdges = computed(() => {
  if (!props.plan.dag || !props.plan.dag.edges) return [];

  const edges = props.plan.dag.edges;
  const nodeMap = {};

  layoutNodes.value.forEach(node => {
    nodeMap[node.id] = node;
  });

  return edges.map(edge => {
    const from = nodeMap[edge.from];
    const to = nodeMap[edge.to];

    if (!from || !to) return null;

    const fromX = from.x + 60; // 节点中心 (120/2)
    const fromY = from.y + 35; // 节点中心 (70/2)
    const toX = to.x + 60;
    const toY = to.y + 35;

    // 使用贝塞尔曲线
    const controlY = (fromY + toY) / 2;
    const path = `M ${fromX} ${fromY} C ${fromX} ${controlY}, ${toX} ${controlY}, ${toX} ${toY}`;

    // 判断边是否激活（前置节点已完成）
    const active = from.status === 'completed';

    return { path, active };
  }).filter(Boolean);
});

// 拓扑排序计算层次
function calculateLayers(nodes, edges) {
  const layers = [];
  const visited = new Set();
  const inDegree = {};

  // 初始化入度
  nodes.forEach(node => {
    inDegree[node.id] = 0;
  });

  edges.forEach(edge => {
    inDegree[edge.to] = (inDegree[edge.to] || 0) + 1;
  });

  // BFS 分层
  let currentLayer = nodes.filter(node => inDegree[node.id] === 0).map(n => n.id);

  while (currentLayer.length > 0) {
    layers.push([...currentLayer]);
    currentLayer.forEach(nodeId => visited.add(nodeId));

    const nextLayer = [];
    currentLayer.forEach(nodeId => {
      const outEdges = edges.filter(e => e.from === nodeId);
      outEdges.forEach(edge => {
        inDegree[edge.to]--;
        if (inDegree[edge.to] === 0 && !visited.has(edge.to)) {
          nextLayer.push(edge.to);
        }
      });
    });

    currentLayer = nextLayer;
  }

  return layers;
}

// 监听计划变化，更新节点状态
watch(() => props.plan, (newPlan) => {
  if (newPlan && newPlan.subtasks) {
    // 触发重新计算
  }
}, { deep: true });

onMounted(() => {
  nextTick(() => {
    if (dagCanvas.value) {
      canvasWidth.value = dagCanvas.value.offsetWidth || 600;
    }
  });
});
</script>

<style scoped>
.execution-plan-card {
  margin-top: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: transparent;
  animation: fadeInUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--shadow-sm);
  transition: all var(--transition-normal);
}

.execution-plan-card:hover {
  border-color: var(--color-border-hover);
}

.card-header {
  background: var(--color-bg-elevated);
  padding: var(--spacing-md);
  font-size: 0.9rem;
  user-select: none;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-weight: 600;
  border-bottom: 1px solid var(--color-border);
}

.card-title {
  font-weight: 600;
  color: var(--color-text-primary);
}

.mode-badge {
  padding: 4px 12px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid var(--color-border);
}

.mode-badge.parallel,
.mode-badge.dag {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-hover);
}

.mode-badge.sequential {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-color: var(--color-border-hover);
}

.subtask-count {
  margin-left: auto;
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  font-weight: 600;
}

.card-content {
  padding: var(--spacing-lg);
  background: transparent;
  overflow: hidden;
}

/* DAG 可视化 */
.dag-container {
  margin: 0;
}

.dag-canvas {
  position: relative;
  min-height: 300px;
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  border: 1px dashed var(--color-border);
  overflow: hidden;
  padding: var(--spacing-md);
}

.dag-node {
  position: absolute;
  width: 120px;
  height: 70px;
  background: var(--color-bg-secondary);
  border: 2px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
}

.dag-node:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--color-border-hover);
}

.dag-node.parallel {
  border-color: var(--color-border-hover);
  background: var(--color-bg-tertiary);
}

.dag-node.running {
  border-color: var(--color-border-hover);
  background: var(--color-bg-tertiary);
  animation: pulse 2s infinite;
}

.dag-node.completed {
  border-color: var(--color-success);
  background: var(--color-success-bg);
}

.dag-node.failed {
  border-color: var(--color-error);
  background: var(--color-error-bg);
}

.node-content {
  text-align: center;
  padding: var(--spacing-xs);
  width: 100%;
}

.node-order {
  font-size: 0.7rem;
  color: var(--color-text-muted);
  margin-bottom: 2px;
}

.node-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 4px;
}

.node-status-icon {
  font-size: 1rem;
}

.dag-edges {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 0;
}

.dag-edge {
  fill: none;
  stroke: var(--color-border);
  stroke-width: 2;
  transition: all 0.3s ease;
}

.dag-edge.active {
  stroke: var(--color-text-muted);
  stroke-width: 3;
}

/* 任务列表（简洁模式） */
.task-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-md);
}

.task-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-elevated);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--color-border);
  transition: all 0.2s ease;
}

.task-item:hover {
  background: var(--color-bg-tertiary);
}

.task-item.running {
  border-left-color: var(--color-text-secondary);
}

.task-item.completed {
  border-left-color: var(--color-success);
}

.task-item.failed {
  border-left-color: var(--color-error);
}

.task-order {
  font-weight: 700;
  color: var(--color-text-muted);
  font-size: 0.8rem;
  min-width: 30px;
}

.task-desc {
  flex: 1;
  font-size: 0.9rem;
  color: var(--color-text-primary);
}

.task-agent {
  font-size: 0.8rem;
  color: var(--color-text-muted);
  padding: 2px 8px;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
}

.task-status {
  font-size: 1.2rem;
}

/* 动画 */
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

@keyframes pulse {
  0%, 100% {
    box-shadow: var(--shadow-sm);
  }
  50% {
    box-shadow: var(--shadow-md);
  }
}

.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  max-height: 2000px;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
}
</style>
