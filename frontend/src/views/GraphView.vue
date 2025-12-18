<template>
  <div class="graph-container">
    <el-row :gutter="20">
      <el-col :span="18">
        <el-card class="graph-card">
          <template #header>
            <div class="card-header">
              <h3>知识图谱可视化</h3>
              <div class="graph-controls">
                <el-button-group>
                  <el-button size="small" @click="zoomIn">
                    <el-icon><ZoomIn /></el-icon>
                  </el-button>
                  <el-button size="small" @click="zoomOut">
                    <el-icon><ZoomOut /></el-icon>
                  </el-button>
                  <el-button size="small" @click="resetView">
                    <el-icon><Refresh /></el-icon>
                  </el-button>
                </el-button-group>
              </div>
            </div>
          </template>
          <div class="graph-view" ref="graphContainer" v-loading="loading"></div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card class="info-card">
          <template #header>
            <div class="card-header">
              <h3>实体信息</h3>
            </div>
          </template>
          <div class="entity-info" v-if="selectedEntity">
            <h4>{{ selectedEntity.name }}</h4>
            <el-divider />
            <div class="entity-properties">
              <div v-for="(value, key) in selectedEntity.properties" :key="key" class="property-item">
                <span class="property-key">{{ key }}:</span>
                <span class="property-value">{{ value }}</span>
              </div>
            </div>
            <el-divider />
            <div class="entity-actions">
              <el-button type="primary" size="small" @click="showRelations">
                查看关系
              </el-button>
              <el-button type="info" size="small" @click="showOnMap" v-if="hasLocation">
                在地图中显示
              </el-button>
            </div>
          </div>
          <div class="no-selection" v-else>
            <el-empty description="请选择一个实体以查看详细信息" />
          </div>
        </el-card>
        
        <el-card class="filter-card" style="margin-top: 20px;">
          <template #header>
            <div class="card-header">
              <h3>图谱筛选</h3>
            </div>
          </template>
          <div class="filter-options">
            <div class="filter-section">
              <h4>实体类型</h4>
              <el-checkbox-group v-model="entityFilters">
                <el-checkbox label="基础实体">基础实体</el-checkbox>
                <el-checkbox label="状态实体">状态实体</el-checkbox>
                <el-checkbox label="地理位置">地理位置</el-checkbox>
                <el-checkbox label="时间">时间</el-checkbox>
              </el-checkbox-group>
            </div>
            
            <div class="filter-section">
              <h4>关系类型</h4>
              <el-checkbox-group v-model="relationFilters">
                <el-checkbox label="状态关系">状态关系</el-checkbox>
                <el-checkbox label="地理关系">地理关系</el-checkbox>
                <el-checkbox label="时间关系">时间关系</el-checkbox>
              </el-checkbox-group>
            </div>
            
            <el-button type="primary" @click="applyFilters" style="width: 100%; margin-top: 15px;">
              应用筛选
            </el-button>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import 'echarts-gl';
import { graphConfig } from '../config';

defineOptions({ name: 'GraphView' });

const router = useRouter();
const loading = ref(true);
const graphContainer = ref(null);
const chart = ref(null);
const selectedEntity = ref(null);
const hasLocation = ref(false);

// 筛选选项
const entityFilters = ref(['基础实体', '状态实体', '地理位置', '时间']);
const relationFilters = ref(['状态关系', '地理关系', '时间关系']);

// 模拟知识图谱数据
const graphData = {
  nodes: [
    { id: '1', name: '广西壮族自治区', category: '基础实体', symbolSize: 30, properties: { '类型': '行政区划', '级别': '省级', '代码': '450000' } },
    { id: '2', name: '2020年', category: '时间', symbolSize: 25, properties: { '类型': '年份', '起始': '2020-01-01', '结束': '2020-12-31' } },
    { id: '3', name: '洪涝灾害', category: '状态实体', symbolSize: 25, properties: { '类型': '自然灾害', '严重程度': '中度' } },
    { id: '4', name: '南宁市', category: '基础实体', symbolSize: 20, properties: { '类型': '行政区划', '级别': '市级', '代码': '450100', '经度': '108.320004', '纬度': '22.82402' } },
    { id: '5', name: '柳州市', category: '基础实体', symbolSize: 20, properties: { '类型': '行政区划', '级别': '市级', '代码': '450200', '经度': '109.411703', '纬度': '24.314617' } },
    { id: '6', name: '桂林市', category: '基础实体', symbolSize: 20, properties: { '类型': '行政区划', '级别': '市级', '代码': '450300', '经度': '110.299121', '纬度': '25.274215' } },
    { id: '7', name: '南宁洪涝', category: '状态实体', symbolSize: 15, properties: { '类型': '灾害状态', '发生时间': '2020-06-15', '受灾人口': '12.5万人' } },
    { id: '8', name: '柳州洪涝', category: '状态实体', symbolSize: 15, properties: { '类型': '灾害状态', '发生时间': '2020-06-20', '受灾人口': '8.3万人' } },
    { id: '9', name: '桂林洪涝', category: '状态实体', symbolSize: 15, properties: { '类型': '灾害状态', '发生时间': '2020-06-25', '受灾人口': '10.1万人' } },
  ],
  links: [
    { source: '1', target: '4', name: '包含', category: '地理关系' },
    { source: '1', target: '5', name: '包含', category: '地理关系' },
    { source: '1', target: '6', name: '包含', category: '地理关系' },
    { source: '1', target: '3', name: '发生', category: '状态关系' },
    { source: '2', target: '3', name: '发生于', category: '时间关系' },
    { source: '3', target: '7', name: '具体表现', category: '状态关系' },
    { source: '3', target: '8', name: '具体表现', category: '状态关系' },
    { source: '3', target: '9', name: '具体表现', category: '状态关系' },
    { source: '4', target: '7', name: '发生地', category: '地理关系' },
    { source: '5', target: '8', name: '发生地', category: '地理关系' },
    { source: '6', target: '9', name: '发生地', category: '地理关系' },
  ]
};

// 初始化图表
const initChart = () => {
  if (chart.value) {
    chart.value.dispose();
  }
  
  chart.value = echarts.init(graphContainer.value);
  
  // 设置图表选项
  const option = {
    title: {
      text: '',
      subtext: '',
      top: 'top',
      left: 'center'
    },
    tooltip: {
      trigger: 'item',
      formatter: (params) => {
        if (params.dataType === 'node') {
          return `<strong>${params.data.name}</strong><br/>类型: ${params.data.category}`;
        } else {
          return `<strong>${params.data.name}</strong><br/>从 ${params.data.source} 到 ${params.data.target}`;
        }
      }
    },
    legend: {
      show: true,
      data: Object.keys(graphConfig.nodeCategories),
      orient: 'horizontal',
      bottom: 10
    },
    animationDuration: 1500,
    animationEasingUpdate: 'quinticInOut',
    series: [{
      name: '知识图谱',
      type: 'graph',
      layout: 'force',
      data: graphData.nodes,
      links: graphData.links,
      categories: Object.keys(graphConfig.nodeCategories).map(name => ({ name })),
      roam: true,
      label: {
        show: true,
        position: 'right',
        formatter: '{b}'
      },
      force: {
        repulsion: 100,
        edgeLength: [80, 120]
      },
      lineStyle: {
        color: 'source',
        curveness: 0.3
      },
      emphasis: {
        focus: 'adjacency',
        lineStyle: {
          width: 4
        }
      }
    }]
  };
  
  // 设置节点颜色
  option.series[0].data.forEach(node => {
    node.itemStyle = {
      color: graphConfig.nodeCategories[node.category] || '#909399'
    };
  });
  
  // 设置边的颜色
  option.series[0].links.forEach(link => {
    link.lineStyle = {
      color: graphConfig.relationCategories[link.category] || '#909399',
      curveness: 0.3
    };
  });
  
  chart.value.setOption(option);
  loading.value = false;
  
  // 添加点击事件
  chart.value.on('click', (params) => {
    if (params.dataType === 'node') {
      selectedEntity.value = {
        id: params.data.id,
        name: params.data.name,
        category: params.data.category,
        properties: params.data.properties || {}
      };
      
      // 检查是否有地理位置信息
      hasLocation.value = selectedEntity.value.properties.hasOwnProperty('经度') && 
                          selectedEntity.value.properties.hasOwnProperty('纬度');
    }
  });
};

// 应用筛选
const applyFilters = () => {
  loading.value = true;
  
  // 筛选节点
  const filteredNodes = graphData.nodes.filter(node => 
    entityFilters.value.includes(node.category)
  );
  
  // 获取筛选后节点的ID
  const nodeIds = filteredNodes.map(node => node.id);
  
  // 筛选边 (只保留连接筛选后节点的边，且关系类型符合筛选条件)
  const filteredLinks = graphData.links.filter(link => 
    nodeIds.includes(link.source) && 
    nodeIds.includes(link.target) &&
    relationFilters.value.includes(link.category)
  );
  
  // 更新图表
  chart.value.setOption({
    series: [{
      data: filteredNodes,
      links: filteredLinks
    }]
  });
  
  loading.value = false;
};

// 缩放控制
const zoomIn = () => {
  chart.value.dispatchAction({
    type: 'graphRoam',
    zoom: 1.2
  });
};

const zoomOut = () => {
  chart.value.dispatchAction({
    type: 'graphRoam',
    zoom: 0.8
  });
};

const resetView = () => {
  chart.value.dispatchAction({
    type: 'graphRoam',
    zoom: 1,
    originX: 0.5,
    originY: 0.5
  });
};

// 查看关系
const showRelations = () => {
  if (!selectedEntity.value) return;
  
  // 高亮显示与所选实体相关的节点和边
  const relatedLinks = graphData.links.filter(link => 
    link.source === selectedEntity.value.id || link.target === selectedEntity.value.id
  );
  
  const relatedNodeIds = new Set();
  relatedLinks.forEach(link => {
    relatedNodeIds.add(link.source);
    relatedNodeIds.add(link.target);
  });
  
  chart.value.dispatchAction({
    type: 'highlight',
    seriesIndex: 0,
    dataIndex: Array.from(relatedNodeIds).map(id => 
      graphData.nodes.findIndex(node => node.id === id)
    )
  });
};

// 在地图中显示
const showOnMap = () => {
  if (!selectedEntity.value || !hasLocation.value) return;
  
  // 导航到地图视图并传递实体信息
  router.push({
    path: '/map',
    query: {
      entityId: selectedEntity.value.id,
      lat: selectedEntity.value.properties.纬度,
      lng: selectedEntity.value.properties.经度,
      name: selectedEntity.value.name
    }
  });
};

// 监听窗口大小变化，调整图表大小
window.addEventListener('resize', () => {
  if (chart.value) {
    chart.value.resize();
  }
});

onMounted(() => {
  // 初始化图表
  initChart();
});

// 监听筛选条件变化
watch([entityFilters, relationFilters], () => {
  // 这里可以添加自动应用筛选的逻辑，或者保持手动点击应用按钮
}, { deep: true });
</script>

<style scoped>
.graph-container {
  padding: 20px;
}

.graph-card {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.graph-view {
  height: 700px;
  width: 100%;
}

.entity-info {
  padding: 10px;
}

.property-item {
  margin-bottom: 8px;
  display: flex;
}

.property-key {
  font-weight: bold;
  margin-right: 5px;
  min-width: 80px;
}

.property-value {
  flex: 1;
  word-break: break-all;
}

.entity-actions {
  display: flex;
  justify-content: space-between;
  margin-top: 15px;
}

.no-selection {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 200px;
}

.filter-section {
  margin-bottom: 15px;
}

.filter-section h4 {
  margin-bottom: 10px;
  font-weight: bold;
}
</style>