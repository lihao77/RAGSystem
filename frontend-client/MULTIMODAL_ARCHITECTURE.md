# 多模态内容展示架构设计

## 概述

本文档描述了前端如何展示智能体返回的多模态内容（图表、地图、表格、视频等），并提供了可扩展的架构设计方案。

## 设计原则

1. **统一数据模型** - 所有多模态内容使用统一的数据结构
2. **组件化渲染** - 每种模态类型有独立的渲染器组件
3. **事件驱动** - 后端通过 SSE 事件流实时推送内容
4. **响应式布局** - 支持全宽/内联/弹窗等多种展示方式
5. **可扩展性** - 方便未来添加新的模态类型

## 核心架构

### 1. 数据流程

```
Backend (Agent)
    → SSE Event Stream
    → Frontend (App.vue)
    → MultimodalContent Container
    → Specific Renderer (ChartRenderer/MapRenderer/...)
```

### 2. 组件层次结构

```
App.vue (主容器)
  ├─ Message (消息容器)
  │   ├─ TaskAnalysisCard (任务分析卡片)
  │   ├─ SubtaskCard[] (子任务卡片列表)
  │   ├─ MultimodalContent (多模态内容容器) ← 新增
  │   │   ├─ ChartRenderer (图表渲染器)
  │   │   ├─ MapRenderer (地图渲染器) - 未来
  │   │   ├─ TableRenderer (表格渲染器) - 未来
  │   │   ├─ ImageRenderer (图片渲染器) - 未来
  │   │   └─ ... (其他渲染器)
  │   ├─ FinalAnswer (最终答案)
  │   └─ StatusUpdates (状态更新)
```

### 3. 数据模型

#### 消息对象结构
```javascript
{
  role: 'assistant',
  content: '最终答案文本',
  taskAnalysis: {...},        // 任务分析数据
  subtasks: [...],            // 子任务列表
  multimodalContents: [       // 多模态内容列表 ← 新增字段
    {
      type: 'chart',          // 模态类型
      echartsConfig: {...},   // 渲染器特定的配置
      title: '图表标题',
      chartType: 'bar'
    },
    {
      type: 'map',
      mapConfig: {...},
      title: '地图标题',
      center: [lat, lng],
      zoom: 12
    }
    // ... 更多模态内容
  ],
  status: []
}
```

## 当前已实现功能

### 1. 图表渲染 (ChartRenderer.vue)

**功能特性：**
- 基于 ECharts 的数据可视化
- 支持柱状图、折线图、饼图、散点图
- 全屏展示功能
- 图表下载（PNG格式）
- 响应式自动调整大小

**使用示例：**
```vue
<ChartRenderer
  :echartsConfig="{...}"
  title="销售数据分析"
  chartType="bar"
/>
```

**后端事件触发：**
```python
# backend/agents/react_agent.py (lines 372-381)
if isinstance(result, dict) and result.get('success') and 'echarts_config' in result:
    yield {
        "type": "chart_generated",
        "echarts_config": result['echarts_config'],
        "chart_type": result.get('chart_type'),
        "title": result.get('echarts_config', {}).get('title', {}).get('text', '图表分析'),
        "data_reference": result.get('data_reference')
    }
```

**前端事件处理：**
```javascript
// App.vue (lines 434-441)
else if (data.type === 'chart_generated') {
  currentMsg.multimodalContents.push({
    type: 'chart',
    echartsConfig: data.echarts_config,
    title: data.title || '数据可视化',
    chartType: data.chart_type || 'bar'
  });
}
```

### 2. 多模态内容容器 (MultimodalContent.vue)

**功能特性：**
- 统一管理所有类型的多模态内容
- 动态组件渲染
- 可扩展的渲染器映射系统

**渲染器映射：**
```javascript
const RENDERER_MAP = {
  chart: ChartRenderer,
  // 未来扩展:
  // map: MapRenderer,
  // table: TableRenderer,
  // image: ImageRenderer,
  // video: VideoRenderer,
  // timeline: TimelineRenderer,
  // graph: GraphRenderer
};
```

## 未来扩展规划

### 1. 地图渲染 (MapRenderer.vue) - 未实现

**应用场景：**
- 空间分析结果展示
- 地理位置标注
- 路径规划可视化
- 热力图展示

**技术选型：**
- Leaflet.js (轻量级、开源)
- MapBox GL JS (高性能、商业化)
- 高德地图 API (国内地图服务)

**数据结构示例：**
```javascript
{
  type: 'map',
  mapConfig: {
    center: [39.9042, 116.4074], // 北京坐标
    zoom: 12,
    markers: [
      { lat: 39.9042, lng: 116.4074, label: '天安门' }
    ],
    heatmapData: [...]
  },
  title: '空间分布图'
}
```

**后端事件：**
```python
yield {
    "type": "map_generated",
    "map_config": {...},
    "title": "空间分布图"
}
```

### 2. 表格渲染 (TableRenderer.vue) - 未实现

**应用场景：**
- 大数据表格展示
- 分页、排序、筛选
- 导出CSV/Excel

**技术选型：**
- Element Plus Table (已引入)
- AG Grid (高性能企业级表格)

**数据结构示例：**
```javascript
{
  type: 'table',
  tableData: [...],
  columns: [
    { prop: 'name', label: '姓名', sortable: true },
    { prop: 'age', label: '年龄', sortable: true }
  ],
  pagination: {
    total: 1000,
    pageSize: 20
  },
  title: '数据汇总表'
}
```

### 3. 时间轴渲染 (TimelineRenderer.vue) - 未实现

**应用场景：**
- 时序分析结果展示
- 事件链追踪
- 因果关系可视化

**数据结构示例：**
```javascript
{
  type: 'timeline',
  events: [
    { time: '2024-01-01', label: '事件A', description: '...' },
    { time: '2024-01-15', label: '事件B', description: '...' }
  ],
  title: '事件时间轴'
}
```

### 4. 关系图谱渲染 (GraphRenderer.vue) - 未实现

**应用场景：**
- 知识图谱可视化
- 实体关系展示
- 社交网络分析

**技术选型：**
- ECharts Graph (简单图谱)
- D3.js (高度自定义)
- Cytoscape.js (专业图谱库)

**数据结构示例：**
```javascript
{
  type: 'graph',
  nodes: [
    { id: 'A', label: '实体A', type: 'person' },
    { id: 'B', label: '实体B', type: 'location' }
  ],
  edges: [
    { source: 'A', target: 'B', label: '位于' }
  ],
  title: '关系图谱'
}
```

### 5. 图片/视频渲染 - 未实现

**应用场景：**
- 多模态模型输出
- 截图展示
- 视频分析结果

**数据结构示例：**
```javascript
// 图片
{
  type: 'image',
  url: '/static/images/result.png',
  caption: '分析结果',
  width: 800,
  height: 600
}

// 视频
{
  type: 'video',
  url: '/static/videos/demo.mp4',
  poster: '/static/images/poster.png',
  controls: true
}
```

## 实现新渲染器的步骤

### 1. 创建渲染器组件

在 `frontend-client/src/components/` 创建新组件，例如 `MapRenderer.vue`：

```vue
<template>
  <div class="map-renderer">
    <div class="map-header">
      <div class="map-title">
        <span class="map-icon">🗺️</span>
        <span>{{ title }}</span>
      </div>
    </div>
    <div ref="mapContainer" class="map-container"></div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  mapConfig: {
    type: Object,
    required: true
  },
  title: {
    type: String,
    default: '地图'
  }
});

const mapContainer = ref(null);
const mapInstance = ref(null);

const initMap = () => {
  // 初始化地图逻辑
};

onMounted(() => {
  initMap();
});

onUnmounted(() => {
  // 清理地图实例
});
</script>

<style scoped>
.map-renderer {
  /* 样式 */
}
</style>
```

### 2. 注册渲染器

在 `MultimodalContent.vue` 中注册新渲染器：

```javascript
import MapRenderer from './MapRenderer.vue';

const RENDERER_MAP = {
  chart: ChartRenderer,
  map: MapRenderer,  // 新增
  // ...
};
```

### 3. 后端发送事件

在相应的工具函数中添加事件触发逻辑：

```python
# backend/tools/tool_executor.py
def spatial_analysis(params):
    # ... 分析逻辑 ...

    return {
        "success": True,
        "map_config": {
            "center": [lat, lng],
            "zoom": 12,
            "markers": [...]
        },
        "message": "空间分析完成"
    }
```

在 ReActAgent 中检测并发送事件：

```python
# backend/agents/react_agent.py
if isinstance(result, dict) and result.get('success') and 'map_config' in result:
    yield {
        "type": "map_generated",
        "map_config": result['map_config'],
        "title": result.get('title', '地图分析')
    }
```

### 4. 前端处理事件

在 `App.vue` 中添加事件处理：

```javascript
else if (data.type === 'map_generated') {
  currentMsg.multimodalContents.push({
    type: 'map',
    mapConfig: data.map_config,
    title: data.title || '地图分析'
  });
}
```

## 最佳实践

### 1. 性能优化

- **按需加载**: 大型渲染器（如地图库）使用动态 import
- **虚拟滚动**: 对于长列表内容使用虚拟滚动
- **懒加载**: 非可见区域的内容延迟渲染

### 2. 用户体验

- **加载状态**: 显示加载动画，避免空白页面
- **错误处理**: 渲染失败时显示友好的错误提示
- **响应式设计**: 适配不同屏幕尺寸
- **交互反馈**: 提供全屏、下载等交互功能

### 3. 代码组织

- **单一职责**: 每个渲染器只负责一种模态类型
- **props 验证**: 使用 PropTypes 验证传入数据
- **样式隔离**: 使用 scoped CSS 避免样式冲突
- **组件文档**: 添加清晰的注释和使用示例

## 技术栈

### 当前使用
- Vue 3.5.24 (Composition API)
- ECharts 6.0.0 (图表库)
- Marked 17.0.1 (Markdown 渲染)

### 未来可能引入
- Leaflet.js / MapBox GL JS (地图)
- D3.js / Cytoscape.js (图谱)
- AG Grid (高性能表格)
- Video.js (视频播放)

## 文件清单

### 已创建
- `frontend-client/src/components/ChartRenderer.vue` - 图表渲染器
- `frontend-client/src/components/MultimodalContent.vue` - 多模态内容容器
- `frontend-client/src/App.vue` (已修改) - 主应用入口，添加了事件处理逻辑

### 待创建（未来）
- `frontend-client/src/components/MapRenderer.vue` - 地图渲染器
- `frontend-client/src/components/TableRenderer.vue` - 表格渲染器
- `frontend-client/src/components/TimelineRenderer.vue` - 时间轴渲染器
- `frontend-client/src/components/GraphRenderer.vue` - 图谱渲染器
- `frontend-client/src/components/ImageRenderer.vue` - 图片渲染器
- `frontend-client/src/components/VideoRenderer.vue` - 视频渲染器

## 测试建议

### 1. 功能测试
- 验证图表是否正确渲染
- 测试全屏和下载功能
- 检查响应式布局

### 2. 性能测试
- 测试同时渲染多个图表的性能
- 检查内存泄漏（组件销毁时是否正确清理）

### 3. 兼容性测试
- Chrome/Edge (Chromium)
- Firefox
- Safari
- 移动端浏览器

## 常见问题

### Q: 如何添加新的图表类型？
A: 在 `generate_chart` 工具中添加新的 chart_type 支持，生成对应的 ECharts 配置即可。

### Q: 如何自定义图表样式？
A: 在 ChartRenderer.vue 中修改 ECharts 主题，或在后端生成配置时自定义样式。

### Q: 多个图表会影响性能吗？
A: ECharts 做了优化，单页面几十个图表问题不大。如果更多，考虑使用虚拟滚动。

### Q: 如何支持图表交互（点击事件等）？
A: 在 ChartRenderer 中监听 ECharts 事件，通过 emit 传递给父组件处理。

## 更新日志

### 2025-01-12
- ✅ 创建多模态内容展示架构
- ✅ 实现 ChartRenderer 图表渲染器
- ✅ 实现 MultimodalContent 容器组件
- ✅ 集成 chart_generated 事件处理
- ✅ 编写架构设计文档

### 未来计划
- ⏳ 实现 MapRenderer 地图渲染器
- ⏳ 实现 TableRenderer 表格渲染器
- ⏳ 实现 TimelineRenderer 时间轴渲染器
- ⏳ 实现 GraphRenderer 图谱渲染器
- ⏳ 添加图表交互功能
- ⏳ 性能优化和虚拟滚动

## 联系方式

如有问题或建议，请联系开发团队或在项目中提 Issue。
