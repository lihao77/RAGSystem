<template>
    <div class="graph-container">
        <div id="forceGraphContainer" ref="forceGraphContainer" class="force-graph"></div>

        <!-- 控制面板 -->
        <div class="graph-controls">
            <button @click="showCompleteGraph" class="control-btn" title="显示全图">
                🌐
            </button>
            <button @click="reloadFullGraph" class="control-btn" title="刷新图谱">
                🔄
            </button>
            <button @click="toggleStats" class="control-btn" :title="showStats ? '隐藏统计' : '显示统计'">
                📊
            </button>
        </div>

        <!-- 统计信息面板 -->
        <div v-if="showStats" class="stats-panel">
            <h4>图谱统计</h4>
            <div class="stat-item">
                <span class="stat-label">总节点数:</span>
                <span class="stat-value">{{ graphData.nodes.length }}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">总关系数:</span>
                <span class="stat-value">{{ graphData.links.length }}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">地点:</span>
                <span class="stat-value">{{ countByType('地点') }}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">设施:</span>
                <span class="stat-value">{{ countByType('设施') }}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">状态:</span>
                <span class="stat-value">{{ countByType('State') }}</span>
            </div>
            <div class="stat-item">
                <span class="stat-label">事件:</span>
                <span class="stat-value">{{ countByType('事件') }}</span>
            </div>
        </div>

        <!-- 实体信息面板 -->
        <!-- <div v-if="selectedEntity" class="entity-info">
            <button class="close-btn" @click="selectedEntity = null">✕</button>
            <h3>{{ selectedEntity.name || selectedEntity.id }}</h3>
            <div class="entity-type">
                <span class="type-icon">
                    {{ selectedEntity.type === '地点' ? '📍' :
                        selectedEntity.type === '设施' ? '🏢' :
                            selectedEntity.type === 'State' ? '⚡' :
                                selectedEntity.type === '事件' ? '🎯' : '●' }}
                </span>
                <span>{{ selectedEntity.type }}</span>
            </div>
            <div v-if="selectedEntity.time" class="entity-time">
                <span>{{ formatTime(selectedEntity.time) }}</span>
            </div>
            <div v-if="selectedEntity.latitude && selectedEntity.longitude" class="entity-geo">
                <span>{{ selectedEntity.latitude.toFixed(4) }}, {{ selectedEntity.longitude.toFixed(4) }}</span>
            </div>
        </div> -->
    </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, watch, shallowRef } from 'vue';
import ForceGraph from 'force-graph';
import { entityService } from '../../api';

// 节流函数 - 限制高频事件触发
const throttle = (fn, delay) => {
    let lastCall = 0;
    return function (...args) {
        const now = Date.now();
        if (now - lastCall >= delay) {
            lastCall = now;
            return fn.apply(this, args);
        }
    };
};

// 响应式状态
const forceGraphContainer = shallowRef(null);
const forceGraph = shallowRef(null);
const graphData = ref({ nodes: [], links: [] });
const selectedEntity = ref(null);
const showStats = ref(false);
const filterType = ref(null);

// 接收父组件传递的属性
const props = defineProps({
    // 当前选中的实体
    entityId: {
        type: String,
        default: null
    },
    viewMode: {
        type: String,
        default: 'split' // 'map', 'graph', 'split'
    }
});

// 向父组件发送事件
const emit = defineEmits(['select-entity']);

// 初始化力导向图
onMounted(() => {
    initForceGraph();
    loadGraphData();

    // 添加窗口大小变化的监听器
    window.addEventListener('resize', handleResize);
});

// 在组件销毁时清理资源
onUnmounted(() => {
    if (forceGraph.value) {
        forceGraph.value._destructor();
    }

    // 移除窗口大小变化的监听器
    window.removeEventListener('resize', handleResize);
});

// 处理窗口大小变化
const handleResize = () => {
    if (forceGraphContainer.value && forceGraph.value) {
        // 更新画布尺寸
        updateGraphDimensions();
    }
};

// 更新图形尺寸
const updateGraphDimensions = () => {
    if (forceGraphContainer.value && forceGraph.value) {
        // 获取容器的当前尺寸
        const width = forceGraphContainer.value.clientWidth;
        const height = forceGraphContainer.value.clientHeight;

        // 设置图形尺寸
        forceGraph.value
            .width(width)
            .height(height);
    }
};

// 加载图谱数据
const loadGraphData = async () => {
    try {
        const data = await entityService.getKnowledgeGraph();

        // 转换数据为力导向图所需格式
        const nodes = data.entities.map(entity => ({
            id: entity.id,
            name: entity.name || entity.value || entity.type || entity.id,
            type: entity.type,
            longitude: entity.longitude,
            latitude: entity.latitude,
            time: entity.time,
            geo: entity.geo,
            entityIds: entity.entityIds,
            // 为3D图添加属性
            val: entity.type === '地点' ? 20 :
                entity.type === '设施' ? 15 :
                    entity.type === 'State' ? 10 :
                        entity.type === '事件' ? 12 : 8,
            highlight: false
        }));
        const links = data.relationships
            .filter(rel => {
                // 验证source和target是否存在且有效
                const sourceExists = nodes.some(node => node.id === rel.source);
                const targetExists = nodes.some(node => node.id === rel.target);
                return sourceExists && targetExists && rel.source && rel.target;
            })
            .map(rel => ({
                source: rel.source,
                target: rel.target,
                type: rel.name || rel.type,
                entities: rel.entities,
                highlight: false
            }));

        // 为相同节点间的多条边分配不同的曲率，避免重叠
        const edgeCount = {}; // 记录每对节点间的边数
        links.forEach(link => {
            // 创建一个统一的键，不考虑方向（因为是无向图的视觉效果）
            const key = [link.source, link.target].sort().join('-');
            if (!edgeCount[key]) {
                edgeCount[key] = [];
            }
            edgeCount[key].push(link);
        });

        // 为每组多条边分配不同的曲率
        Object.values(edgeCount).forEach(linkGroup => {
            if (linkGroup.length === 1) {
                // 单条边使用默认曲率
                linkGroup[0].__curvature = 0.15;
            } else {
                // 多条边：分散到不同曲率
                linkGroup.forEach((link, index) => {
                    // 均匀分布：-0.3, -0.15, 0, 0.15, 0.3 等
                    const step = 0.15;
                    const offset = (index - (linkGroup.length - 1) / 2) * step;
                    link.__curvature = 0.15 + offset;
                });
            }
        });

        graphData.value = { nodes, links };
        // 更新力导向图数据
        if (forceGraph.value) {
            forceGraph.value.graphData({
                nodes,
                links
            });

            // 更新画布尺寸
            updateGraphDimensions();

            // 如果有选中的实体，高亮显示
            if (props.entityId) {
                highlightEntityAndRelated(props.entityId);
            } else {
                // 初始加载时，确保图形能完整显示
                setTimeout(() => {
                    forceGraph.value.zoomToFit(400, 100);
                }, 1000);
            }
        }
    } catch (err) {
        console.error('获取数据错误:', err);
    }
};

// 处理节点点击事件
const handleNodeClick = (node) => {
    selectedEntity.value = node;
    emit('select-entity', node);
};

// 高亮显示实体及其相关节点
const highlightEntityAndRelated = async (entityId) => {
    if (!graphData.value || !graphData.value.nodes.length) return;

    // 重置所有节点和连接的高亮状态
    graphData.value.nodes.forEach(node => node.highlight = false);
    graphData.value.links.forEach(link => link.highlight = false);

    // 找到目标实体节点
    const targetNode = graphData.value.nodes.find(node => node.id === entityId);
    if (!targetNode) return;

    // 高亮目标节点
    targetNode.highlight = true;

    // 找出与目标节点直接相连的所有连接和节点
    const relatedLinks = graphData.value.links.filter(
        link => link.source === entityId || link.target === entityId ||
            (typeof link.source === 'object' && link.source.id === entityId) ||
            (typeof link.target === 'object' && link.target.id === entityId)
    );

    // 高亮相关连接
    relatedLinks.forEach(link => link.highlight = true);

    // 高亮相关节点
    const relatedNodeIds = new Set();
    relatedLinks.forEach(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        relatedNodeIds.add(sourceId);
        relatedNodeIds.add(targetId);
    });

    // 创建一个新的节点数组，只包含相关节点
    const visibleNodes = graphData.value.nodes.filter(node =>
        node.id === entityId || relatedNodeIds.has(node.id)
    );

    // 创建一个新的连接数组，只包含相关连接
    const visibleLinks = graphData.value.links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        return relatedNodeIds.has(sourceId) && relatedNodeIds.has(targetId);
    });

    // 如果是地点或设施，获取其状态链和相关事件
    if (targetNode.type === '地点' || targetNode.type === '设施') {
        try {
            // 获取状态链
            const statesData = await entityService.getEntityStates(entityId);

            // 高亮状态链中的所有状态节点
            statesData.states.forEach(state => {
                const stateNode = graphData.value.nodes.find(node => node.id === state.id);
                if (stateNode) {
                    stateNode.highlight = true;
                    relatedNodeIds.add(state.id);
                    // 添加到可见节点
                    if (!visibleNodes.some(node => node.id === state.id)) {
                        const node = graphData.value.nodes.find(n => n.id === state.id);
                        if (node) visibleNodes.push(node);
                    }
                }
            });

            // 获取相关事件
            const eventsData = await entityService.getEntityEvents(entityId);
            // 高亮相关事件及其状态
            eventsData.forEach(event => {
                const eventNode = graphData.value.nodes.find(node => node.id === event.id);
                if (eventNode) {
                    eventNode.highlight = true;
                    relatedNodeIds.add(event.id);
                    // 添加到可见节点
                    if (!visibleNodes.some(node => node.id === event.id)) {
                        visibleNodes.push(eventNode);
                    }
                }

                // 高亮事件的状态
                if (event.states) {
                    event.states.forEach(stateId => {
                        const stateNode = graphData.value.nodes.find(node => node.id === stateId);
                        if (stateNode) {
                            stateNode.highlight = true;
                            relatedNodeIds.add(stateId);
                            // 添加到可见节点
                            if (!visibleNodes.some(node => node.id === stateId)) {
                                visibleNodes.push(stateNode);
                            }
                        }
                    });
                }
            });
        } catch (err) {
            console.error('获取相关数据错误:', err);
        }
    }

    // 更新可见连接，确保包含所有相关节点之间的连接
    graphData.value.links.forEach(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        if (relatedNodeIds.has(sourceId) && relatedNodeIds.has(targetId)) {
            if (link.type === 'nextState' || link.type === 'contain') {
                // console.log('检查连接:', link);
                if (link.entities.includes(entityId)) {
                    link.highlight = true;
                    if (!visibleLinks.some(l =>
                        (l.source === link.source && l.target === link.target) ||
                        (l.source === link.target && l.target === link.source)
                    )) {
                        visibleLinks.push(link);
                    }
                }
            } else {
                link.highlight = true;
                if (!visibleLinks.some(l =>
                    (l.source === link.source && l.target === link.target) ||
                    (l.source === link.target && l.target === link.source)
                )) {
                    visibleLinks.push(link);
                }
            }
        }
    });

    // 更新力导向图数据，只显示相关节点和连接
    if (forceGraph.value) {
        forceGraph.value.graphData({
            nodes: visibleNodes,
            links: visibleLinks
        });

        // 等待布局稳定后聚焦到子图
        // 使用多次延迟确保力导向图已完成初始布局
        setTimeout(() => {
            if (!forceGraph.value) return;
            
            const currentNodes = forceGraph.value.graphData().nodes;
            
            // 检查节点是否已有坐标
            const nodesWithCoords = currentNodes.filter(node => 
                node.x !== undefined && node.y !== undefined
            );
            
            if (nodesWithCoords.length === 0) {
                // 如果节点还没有坐标，延迟再试一次
                setTimeout(() => {
                    if (forceGraph.value) {
                        forceGraph.value.zoomToFit(400, 100);
                    }
                }, 300);
                return;
            }
            
            // 计算所有可见节点的边界范围
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            
            nodesWithCoords.forEach(node => {
                if (node.x < minX) minX = node.x;
                if (node.x > maxX) maxX = node.x;
                if (node.y < minY) minY = node.y;
                if (node.y > maxY) maxY = node.y;
            });
            
            // 计算中心点
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            
            // 计算范围大小
            const width = maxX - minX;
            const height = maxY - minY;
            const maxDimension = Math.max(width, height);
            
            // 获取画布尺寸
            const canvasWidth = forceGraphContainer.value.clientWidth;
            const canvasHeight = forceGraphContainer.value.clientHeight;
            const minCanvasDimension = Math.min(canvasWidth, canvasHeight);
            
            // 根据节点分布范围和画布大小计算合适的缩放级别
            // 添加 0.7 的系数留出边距
            let targetZoom = (minCanvasDimension / maxDimension) * 0.7;
            
            // 限制缩放范围，避免过大或过小
            targetZoom = Math.max(0.5, Math.min(targetZoom, 5));
            
            // 将中心点向左偏移90px，避免被右侧控制按钮遮挡
            // const offsetCenterX = centerX + (20 / targetZoom);
            
            // 平滑移动到中心并缩放
            forceGraph.value
                .centerAt(centerX, centerY, 1000)
                .zoom(targetZoom, 1000);
        }, 500); // 增加延迟时间，确保布局稳定
    }
    
    // 更新选中的实体
    selectedEntity.value = targetNode;
};

// 重置图谱高亮并显示完整图谱
const resetGraphHighlight = () => {
    if (!graphData.value) return;

    graphData.value.nodes.forEach(node => node.highlight = false);
    graphData.value.links.forEach(link => link.highlight = false);

    // 恢复显示所有节点和连接
    if (forceGraph.value) {
        forceGraph.value.graphData({
            nodes: graphData.value.nodes,
            links: graphData.value.links
        });
        // 更新画布尺寸
        updateGraphDimensions();
    }
};

// 显示完整图谱
const showCompleteGraph = () => {
    selectedEntity.value = null;

    // 重置视图
    if (forceGraph.value) {
        forceGraph.value.graphData({
            nodes: graphData.value.nodes,
            links: graphData.value.links
        });
        // 更新画布尺寸
        updateGraphDimensions();
        // 平滑缩放到适应所有节点
        setTimeout(() => {
            forceGraph.value.zoomToFit(400, 100);
        }, 100);
    }
};

// 更新力导向图
const updateForceGraph = () => {
    if (!forceGraph.value) return;

    // 更新画布尺寸
    updateGraphDimensions();
};

// 重新加载完整图谱
const reloadFullGraph = () => {
    if (!forceGraph.value || !graphData.value) return;

    forceGraph.value.graphData({
        nodes: graphData.value.nodes,
        links: graphData.value.links
    });
    // 更新画布尺寸
    updateGraphDimensions();
    setTimeout(() => {
        forceGraph.value.zoomToFit(400, 100);
    }, 500);
};

// 格式化时间显示
const formatTime = (timeString) => {
    if (!timeString) return '未知时间';

    // 处理时间范围格式 (2023-10-01至2023-10-10)
    if (timeString.includes('至')) {
        const [start, end] = timeString.split('至');
        return `${formatDate(start)} 至 ${formatDate(end)}`;
    }

    return formatDate(timeString);
};

// 格式化日期
const formatDate = (dateString) => {
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return dateString; // 如果无法解析，返回原始字符串

        return date.toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    } catch (e) {
        return dateString;
    }
};

// 切换统计面板显示
const toggleStats = () => {
    showStats.value = !showStats.value;
};

// 统计特定类型的节点数量
const countByType = (type) => {
    return graphData.value.nodes.filter(node => node.type === type).length;
};

// 按类型筛选节点
const filterByType = (type) => {
    if (filterType.value === type) {
        clearFilter();
        return;
    }
    
    filterType.value = type;
    
    if (!forceGraph.value || !graphData.value) return;
    
    // 筛选出指定类型的节点
    const filteredNodes = graphData.value.nodes.filter(node => node.type === type);
    const filteredNodeIds = new Set(filteredNodes.map(n => n.id));
    
    // 筛选出与这些节点相关的连接
    const filteredLinks = graphData.value.links.filter(link => {
        const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
        const targetId = typeof link.target === 'object' ? link.target.id : link.target;
        return filteredNodeIds.has(sourceId) && filteredNodeIds.has(targetId);
    });
    
    // 更新图谱显示
    forceGraph.value.graphData({
        nodes: filteredNodes,
        links: filteredLinks
    });
    
    // 适应视图
    setTimeout(() => {
        forceGraph.value.zoomToFit(400, 100);
    }, 100);
};

// 清除筛选
const clearFilter = () => {
    filterType.value = null;
    showCompleteGraph();
};

// 监听entityId变化，更新选中的实体和相关节点
watch(() => props.entityId, (newId) => {
    if (newId) {
        highlightEntityAndRelated(newId);
    } else {
        // 当取消选择实体时，显示完整图谱
        showCompleteGraph();
        selectedEntity.value = null;
    }
}, { immediate: true });


// 监听viewMode变化，
watch(() => props.viewMode, () => {
    // 刷新图形以适应新视图模式
    setTimeout(() => {
        updateForceGraph();
    }, 0);
    console.log('viewMode changed:', props.viewMode);
}, { immediate: true });
// 节点颜色配置
const getNodeColor = (node) => {
    if (node.highlight) {
        return node.type === '地点' ? '#ff6b35' :
            node.type === '设施' ? '#5cb85c' :
                node.type === 'State' ? '#42a5f5' :
                    node.type === '事件' ? '#ffca28' : '#9e9e9e';
    }
    return node.type === '地点' ? '#ff5722' :
        node.type === '设施' ? '#4caf50' :
            node.type === 'State' ? '#2196f3' :
                node.type === '事件' ? '#ffc107' : '#757575';
};

// 节点大小配置
const getNodeSize = (node) => {
    const baseSize = node.type === '地点' ? 10 :
        node.type === '设施' ? 10 :
            node.type === 'State' ? 7 :
                node.type === '事件' ? 6 : 4;
    return node.highlight ? baseSize * 1.5 : baseSize;
};

// 绘制节点
const drawNode = (node, ctx, globalScale) => {
    const fullLabel = node.name || node.id;
    // 限制标签最多显示10个字符
    const label = fullLabel.length > 10 ? fullLabel.substring(0, 10) + '...' : fullLabel;
    // 固定字体大小，不随缩放变化
    const fontSize = node.highlight ? 8 : 7;
    const iconSize = 13;
    const nodeSize = getNodeSize(node);
    
    // 绘制节点阴影
    if (node.highlight) {
        ctx.shadowBlur = 15;
        ctx.shadowColor = getNodeColor(node);
    } else {
        ctx.shadowBlur = 5;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
    }
    
    // 绘制节点圆形
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeSize, 0, 2 * Math.PI, false);
    ctx.fillStyle = getNodeColor(node);
    ctx.fill();
    
    // 绘制节点边框
    ctx.strokeStyle = node.highlight ? '#1976d2' : 'rgba(100, 100, 100, 0.3)';
    ctx.lineWidth = node.highlight ? 2.5 / globalScale : 1.5 / globalScale;
    ctx.stroke();
    
    // 重置阴影
    ctx.shadowBlur = 0;
    
    // 绘制图标（根据类型）- 固定大小
    ctx.font = `${iconSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const icon = node.type === '地点' ? '📍' :
        node.type === '设施' ? '🏢' :
            node.type === 'State' ? '⚡' :
                node.type === '事件' ? '🎯' : '●';
    ctx.fillText(icon, node.x, node.y);
    
    // 绘制标签 - 固定大小
    ctx.font = `${fontSize}px Arial`;
    ctx.fillStyle = node.highlight ? '#1976d2' : '#333';
    ctx.textBaseline = 'top';
    
    // 添加标签背景
    const textWidth = ctx.measureText(label).width;
    const padding = 3;
    const bgHeight = fontSize + padding * 2;
    const bgY = node.y + nodeSize + 4;
    
    ctx.fillStyle = node.highlight ? 'rgba(25, 118, 210, 0.1)' : 'rgba(255, 255, 255, 0.9)';
    ctx.fillRect(
        node.x - textWidth / 2 - padding,
        bgY - padding,
        textWidth + padding * 2,
        bgHeight
    );
    
    // 绘制标签文字
    ctx.fillStyle = node.highlight ? '#1976d2' : '#333';
    ctx.fillText(label, node.x, bgY);
};

// 初始化2D力导向图
const initForceGraph = () => {
    if (!forceGraphContainer.value) return;

    const width = forceGraphContainer.value.clientWidth;
    const height = forceGraphContainer.value.clientHeight;

    forceGraph.value = ForceGraph()(forceGraphContainer.value)
        .width(width)
        .height(height)
        .backgroundColor('#f5f7fa') // 亮色背景
        .nodeRelSize(6)
        .nodeId('id')
        .nodeVal(node => getNodeSize(node))
        .nodeLabel(node => {
            // 鼠标悬停时显示完整信息
            const nodeName = node.name || node.id || '';
            const nodeType = node.type || '未知';
            
            // 根据节点类型选择图标和颜色
            const typeConfig = {
                '地点': { icon: '📍', color: '#ff5722', bgColor: '#ffebee' },
                '设施': { icon: '🏢', color: '#4caf50', bgColor: '#e8f5e9' },
                'State': { icon: '⚡', color: '#2196f3', bgColor: '#e3f2fd' },
                '事件': { icon: '🎯', color: '#ffc107', bgColor: '#fff8e1' }
            };
            
            const config = typeConfig[nodeType] || { icon: '●', color: '#757575', bgColor: '#f5f5f5' };
            
            let label = `
                <div style="
                    background: #ffffff !important;
                    background-color: #ffffff !important;
                    background-image: linear-gradient(135deg, #ffffff 0%, #fafbfc 100%) !important;
                    border-radius: 12px;
                    padding: 0;
                    margin: 0;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
                    border: 2px solid ${config.color}30;
                    max-width: 300px;
                    min-width: 220px;
                    overflow: hidden;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    position: relative;
                    z-index: 9999;
                ">
                    <!-- 顶部彩色条 -->
                    <div style="
                        background: linear-gradient(135deg, ${config.color} 0%, ${config.color}dd 100%);
                        padding: 12px 16px;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    ">
                        <span style="font-size: 20px;">${config.icon}</span>
                        <div style="flex: 1; min-width: 0;">
                            <div style="
                                color: white;
                                font-size: 14px;
                                font-weight: 600;
                                word-wrap: break-word;
                                overflow-wrap: break-word;
                                line-height: 1.4;
                                text-shadow: 0 1px 2px rgba(0,0,0,0.1);
                            ">${nodeName}</div>
                        </div>
                    </div>
                    
                    <!-- 内容区域 -->
                    <div style="padding: 12px 16px; background: #ffffff; background-color: #ffffff;">
                        <!-- 类型 -->
                        <div style="
                            display: flex;
                            align-items: center;
                            padding: 8px 12px;
                            background: ${config.bgColor};
                            border-radius: 6px;
                            margin-bottom: 8px;
                        ">
                            <span style="
                                color: ${config.color};
                                font-weight: 600;
                                font-size: 12px;
                                letter-spacing: 0.5px;
                            ">${nodeType}</span>
                        </div>
                        
                        ${node.time ? `
                        <!-- 时间 -->
                        <div style="
                            display: flex;
                            align-items: flex-start;
                            gap: 8px;
                            padding: 6px 0;
                            border-bottom: 1px solid #f0f0f0;
                            margin-bottom: 8px;
                        ">
                            <span style="font-size: 14px;">🕒</span>
                            <div style="flex: 1; min-width: 0;">
                                <div style="
                                    font-size: 11px;
                                    color: #999;
                                    margin-bottom: 2px;
                                    text-transform: uppercase;
                                    letter-spacing: 0.5px;
                                ">时间</div>
                                <div style="
                                    font-size: 13px;
                                    color: #333;
                                    word-wrap: break-word;
                                    overflow-wrap: break-word;
                                    line-height: 1.4;
                                ">${formatTime(node.time)}</div>
                            </div>
                        </div>
                        ` : ''}
                        
                        ${node.latitude && node.longitude ? `
                        <!-- 坐标 -->
                        <div style="
                            display: flex;
                            align-items: flex-start;
                            gap: 8px;
                            padding: 6px 0;
                        ">
                            <span style="font-size: 14px;">📍</span>
                            <div style="flex: 1; min-width: 0;">
                                <div style="
                                    font-size: 11px;
                                    color: #999;
                                    margin-bottom: 2px;
                                    text-transform: uppercase;
                                    letter-spacing: 0.5px;
                                ">坐标</div>
                                <div style="
                                    font-size: 12px;
                                    color: #666;
                                    font-family: 'Courier New', monospace;
                                    word-wrap: break-word;
                                    overflow-wrap: break-word;
                                    line-height: 1.4;
                                ">${node.latitude.toFixed(4)}, ${node.longitude.toFixed(4)}</div>
                            </div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            `;
            
            return label;
        })
        .nodeCanvasObject(drawNode)
        .nodeCanvasObjectMode(() => 'replace')
        .linkSource('source')
        .linkTarget('target')
        .linkWidth(link => link.highlight ? 3 : 1.5)
        .linkColor(link => {
            if (link.highlight) return '#ff9800';
            if (link.type && link.type.includes('发生')) return 'rgba(255, 152, 0, 0.7)';
            if (link.type && link.type.includes('位于')) return 'rgba(33, 150, 243, 0.7)';
            if (link.type && link.type.includes('导致')) return 'rgba(233, 30, 99, 0.7)';
            if (link.type === 'nextState') return 'rgba(156, 39, 176, 0.7)';
            if (link.type === 'contain') return 'rgba(0, 150, 136, 0.7)';
            return 'rgba(120, 120, 120, 0.5)';
        })
        .linkDirectionalArrowLength(link => link.highlight ? 6 : 4)
        .linkDirectionalArrowRelPos(1)
        .linkDirectionalArrowColor(link => link.highlight ? '#ff9800' : 'rgba(100, 100, 100, 0.6)')
        .linkCurvature(link => {
            // 为相同节点间的多条边分配不同的曲率
            if (!link.__curvature) {
                link.__curvature = 0.15; // 默认曲率
            }
            return link.__curvature;
        })
        .linkCanvasObjectMode(() => 'after')
        .linkCanvasObject((link, ctx) => {
            // 在链接上绘制标签
            if (!link.type) return;
            
            const start = link.source;
            const end = link.target;
            
            if (typeof start !== 'object' || typeof end !== 'object') return;
            
            // 使用链接的实际曲率（可能因为多条边而不同）
            const curvature = link.__curvature || 0.15;
            
            // 计算两点间的直线中点
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            
            // 计算垂直于连线的方向向量
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            
            // 曲线的控制点：在中点的垂直方向偏移
            // 垂直向量是 (dy, -dx)，归一化后乘以偏移量（反向）
            const offset = curvature * distance;
            const controlX = midX + (dy / distance) * offset;
            const controlY = midY + (-dx / distance) * offset;
            
            // 在二次贝塞尔曲线上 t=0.5 的位置（曲线中点）
            // B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
            // 当 t=0.5 时: B(0.5) = 0.25P0 + 0.5P1 + 0.25P2
            const t = 0.5;
            const curveX = (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * controlX + t * t * end.x;
            const curveY = (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * controlY + t * t * end.y;
            
            // 计算曲线在 t=0.5 处的切线方向（导数）
            // B'(t) = 2(1-t)(P1-P0) + 2t(P2-P1)
            const derivX = 2 * (1 - t) * (controlX - start.x) + 2 * t * (end.x - controlX);
            const derivY = 2 * (1 - t) * (controlY - start.y) + 2 * t * (end.y - controlY);
            let angle = Math.atan2(derivY, derivX);
            
            // 确保文字始终是正向可读的（不会倒置）
            if (angle > Math.PI / 2) {
                angle -= Math.PI;
            } else if (angle < -Math.PI / 2) {
                angle += Math.PI;
            }
            
            const label = link.type;
            
            // 保存当前画布状态
            ctx.save();
            
            // 移动到曲线上的真实中点
            ctx.translate(curveX, curveY);
            
            // 旋转画布，使文字方向与曲线切线方向一致
            ctx.rotate(angle);
            
            // 设置字体和对齐方式
            ctx.font = '7px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // 高亮时使用蓝色，普通状态使用灰色
            ctx.fillStyle = link.highlight ? '#1976d2' : '#666';
            
            // 在旋转后的坐标系中绘制文字（原点已经在文字位置）
            ctx.fillText(label, 0, 0);
            
            // 恢复画布状态
            ctx.restore();
        })
        .linkDirectionalParticles(link => link.highlight ? 4 : 0)
        .linkDirectionalParticleWidth(link => link.highlight ? 3 : 2)
        .linkDirectionalParticleSpeed(0.006)
        .linkDirectionalParticleColor(() => '#ff9800')
        .onNodeClick(handleNodeClick)
        .onNodeHover(node => {
            if (forceGraphContainer.value) {
                forceGraphContainer.value.style.cursor = node ? 'pointer' : 'default';
            }
        })
        .onLinkHover(link => {
            if (link) {
                // 临时高亮悬停的链接
                link.__hovered = true;
            }
        })
        .enableNodeDrag(true)
        .enableZoomInteraction(true)
        .enablePanInteraction(true);
    
    // 配置 d3 力（需要在初始化之后单独配置）
    forceGraph.value.d3Force('charge').strength(-200);
    forceGraph.value.d3Force('link').distance(80);
    forceGraph.value.d3Force('center', null);
};


</script>

<style scoped>
.graph-container {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #f5f7fa; /* 改为亮色背景，与画布背景一致 */
}

.force-graph {
    width: 100%;
    height: 100%;
}

/* 控制面板样式 */
.graph-controls {
    position: absolute;
    top: 50px;
    right: 6px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 10;
}

.control-btn {
    width: 40px;
    height: 40px;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(250, 251, 252, 0.95) 100%);
    color: #1890ff;
    border: 1px solid rgba(24, 144, 255, 0.2);
    border-radius: 10px;
    padding: 0;
    font-size: 20px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    backdrop-filter: blur(10px);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.control-btn:hover {
    background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%);
    transform: translateY(-2px) scale(1.05);
    box-shadow: 0 4px 16px rgba(24, 144, 255, 0.3);
    border-color: #1890ff;
}

.control-btn:hover {
    filter: brightness(1.2);
}

.control-btn:active {
    transform: translateY(0) scale(0.98);
}

/* 统计面板样式 */
.stats-panel {
    position: absolute;
    top: 20px;
    right: 80px;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(250, 251, 252, 0.95) 100%);
    color: #333;
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(24, 144, 255, 0.2);
    z-index: 10;
    min-width: 180px;
    animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
    from {
        opacity: 0;
        transform: translateX(20px);
    }
    to {
        opacity: 1;
        transform: translateX(0);
    }
}

.stats-panel h4 {
    margin: 0 0 12px 0;
    font-size: 15px;
    font-weight: 600;
    color: #1a1a1a;
    border-bottom: 2px solid #e3e8ef;
    padding-bottom: 8px;
}

.stat-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(24, 144, 255, 0.05);
    transition: background 0.2s;
}

.stat-item:hover {
    background: rgba(24, 144, 255, 0.1);
}

.stat-label {
    font-size: 13px;
    color: #666;
}

.stat-value {
    font-size: 15px;
    font-weight: 600;
    color: #1890ff;
    min-width: 40px;
    text-align: right;
}

/* 实体信息面板样式 - 统一设计 */
.entity-info {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.98) 0%, rgba(250, 251, 252, 0.98) 100%);
    color: #333;
    border-radius: 16px;
    padding: 24px;
    max-width: 360px;
    min-width: 300px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.8);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    transform-origin: bottom left;
    animation: fadeInUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    word-wrap: break-word;
    overflow-wrap: break-word;
}

@keyframes fadeInUp {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

.close-btn {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.9) 0%, rgba(245, 247, 250, 0.9) 100%);
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 50%;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    color: #666;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.close-btn:hover {
    background: linear-gradient(135deg, #ff5722 0%, #e64a19 100%);
    color: white;
    transform: rotate(90deg) scale(1.1);
    box-shadow: 0 4px 12px rgba(255, 87, 34, 0.3);
}

.entity-info h3 {
    margin: 0 40px 16px 0;
    font-size: 20px;
    font-weight: 600;
    color: #1a1a1a;
    border-bottom: 2px solid #e3e8ef;
    padding-bottom: 12px;
    line-height: 1.4;
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: normal;
}

.entity-type {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    color: #1890ff;
    background: linear-gradient(135deg, rgba(24, 144, 255, 0.1) 0%, rgba(9, 109, 217, 0.1) 100%);
    padding: 8px 14px;
    border-radius: 20px;
    border: 1px solid rgba(24, 144, 255, 0.2);
    margin-bottom: 12px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(24, 144, 255, 0.1);
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: normal;
    max-width: 100%;
}

.type-icon {
    margin-right: 4px;
    font-size: 16px;
    filter: drop-shadow(0 0 2px rgba(24, 144, 255, 0.3));
    flex-shrink: 0;
}

.entity-time,
.entity-geo {
    font-size: 13px;
    color: #666;
    margin-top: 12px;
    display: flex;
    align-items: flex-start;
    padding: 10px 12px;
    background: #f8f9fb;
    border-radius: 8px;
    border-left: 3px solid #1890ff;
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: normal;
    line-height: 1.5;
}

.entity-time:before {
    content: '🕒';
    margin-right: 8px;
    font-size: 16px;
    flex-shrink: 0;
}

.entity-geo:before {
    content: '📍';
    margin-right: 8px;
    font-size: 16px;
    flex-shrink: 0;
}

.entity-time > span,
.entity-geo > span {
    flex: 1;
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: normal;
}

.entity-type > span {
    word-wrap: break-word;
    overflow-wrap: break-word;
    white-space: normal;
}

/* 响应式设计 */
@media (max-width: 768px) {
    .graph-controls,
    .stats-panel {
        right: 10px;
    }
    
    .entity-info {
        left: 10px;
    }
    
    .stats-panel {
        top: auto;
        bottom: 20px;
        right: 10px;
    }
}
</style>

<!-- 全局样式，用于覆盖 force-graph 的默认 tooltip 样式 -->
<style>
/* 覆盖 OpenLayers 地图的 tooltip 背景（这是导致灰色的罪魁祸首！） */
.float-tooltip-kap {
    background: transparent !important;
    background-color: transparent !important;
}

/* 覆盖 force-graph 库的默认 tooltip 背景 - 使用多种选择器确保生效 */
.scene-tooltip,
.graph-tooltip,
.force-graph .scene-tooltip,
#forceGraphContainer .scene-tooltip,
.graph-container .scene-tooltip {
    background: transparent !important;
    background-color: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
    box-shadow: none !important;
    pointer-events: none !important;
}

.scene-tooltip > div,
.graph-tooltip > div,
.scene-tooltip div,
.graph-container .scene-tooltip > div,
.graph-container .scene-tooltip div {
    background: transparent !important;
    background-color: transparent !important;
}

/* 确保 tooltip 容器本身也是透明的 */
div[style*="position: absolute"][style*="pointer-events"] {
    background: transparent !important;
}
</style>