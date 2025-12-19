<template>
  <div class="chart-renderer">
    <!-- 图表容器 -->
    <div v-if="chartConfig" class="chart-container">
      <div ref="chartRef" class="echarts-chart"></div>
      
      <!-- 工具栏 -->
      <div class="chart-toolbar">
        <el-button 
          size="small" 
          :icon="Download" 
          @click="downloadChart"
          class="toolbar-btn"
        >
          下载图表
        </el-button>
        <el-button 
          size="small" 
          :icon="DataAnalysis" 
          @click="toggleDataSummary"
          class="toolbar-btn"
        >
          {{ showDataSummary ? '隐藏' : '显示' }}数据摘要
        </el-button>
      </div>
      
      <!-- 数据摘要 -->
      <el-collapse-transition>
        <div v-show="showDataSummary" class="data-summary">
          <h4>📊 数据摘要</h4>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="图表类型">
              {{ chartType }}
            </el-descriptions-item>
            <el-descriptions-item label="数据记录数">
              {{ dataSummary.total_records }} 条
            </el-descriptions-item>
            
            <template v-for="(stats, field) in numericStats" :key="field">
              <el-descriptions-item :label="`${field} - 最小值`">
                {{ stats.min }}
              </el-descriptions-item>
              <el-descriptions-item :label="`${field} - 最大值`">
                {{ stats.max }}
              </el-descriptions-item>
              <el-descriptions-item :label="`${field} - 平均值`">
                {{ stats.avg }}
              </el-descriptions-item>
              <el-descriptions-item :label="`${field} - 总和`">
                {{ stats.sum }}
              </el-descriptions-item>
            </template>
          </el-descriptions>
        </div>
      </el-collapse-transition>
    </div>
    
    <!-- 空状态 -->
    <el-empty v-else description="暂无图表数据" />
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import * as echarts from 'echarts'
import { Download, DataAnalysis } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  // ECharts 配置对象
  chartConfig: {
    type: Object,
    default: null
  },
  // 图表类型
  chartType: {
    type: String,
    default: ''
  },
  // 数据摘要
  dataSummary: {
    type: Object,
    default: () => ({})
  },
  // 图表高度
  height: {
    type: String,
    default: '400px'
  }
})

const chartRef = ref(null)
let chartInstance = null
const showDataSummary = ref(false)

// 计算数值统计信息
const numericStats = computed(() => {
  const stats = {}
  if (props.dataSummary) {
    Object.keys(props.dataSummary).forEach(key => {
      if (key !== 'total_records' && key !== 'chart_type') {
        stats[key] = props.dataSummary[key]
      }
    })
  }
  return stats
})

// 初始化图表
const initChart = () => {
  if (!chartRef.value || !props.chartConfig) return
  
  // 如果已存在实例，先销毁
  if (chartInstance) {
    chartInstance.dispose()
  }
  
  // 创建新实例
  chartInstance = echarts.init(chartRef.value)
  chartInstance.setOption(props.chartConfig)
  
  // 响应式调整
  window.addEventListener('resize', handleResize)
}

// 窗口大小变化处理
const handleResize = () => {
  if (chartInstance) {
    chartInstance.resize()
  }
}

// 下载图表
const downloadChart = () => {
  if (!chartInstance) return
  
  try {
    const url = chartInstance.getDataURL({
      type: 'png',
      pixelRatio: 2,
      backgroundColor: '#fff'
    })
    
    const link = document.createElement('a')
    link.href = url
    link.download = `chart_${Date.now()}.png`
    link.click()
    
    ElMessage.success('图表下载成功')
  } catch (error) {
    console.error('下载图表失败:', error)
    ElMessage.error('下载图表失败')
  }
}

// 切换数据摘要显示
const toggleDataSummary = () => {
  showDataSummary.value = !showDataSummary.value
}

// 监听配置变化
watch(() => props.chartConfig, async () => {
  await nextTick()
  initChart()
}, { deep: true })

// 生命周期
onMounted(() => {
  initChart()
})

onBeforeUnmount(() => {
  if (chartInstance) {
    window.removeEventListener('resize', handleResize)
    chartInstance.dispose()
    chartInstance = null
  }
})
</script>

<style scoped>
.chart-renderer {
  width: 100%;
}

.chart-container {
  background: #fff;
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.echarts-chart {
  width: 100%;
  height: v-bind(height);
}

.chart-toolbar {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}

.toolbar-btn {
  min-width: 120px;
}

.data-summary {
  margin-top: 16px;
  padding: 16px;
  background: #f5f7fa;
  border-radius: 4px;
}

.data-summary h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  color: #303133;
}

:deep(.el-descriptions__label) {
  font-weight: 500;
}

:deep(.el-descriptions__content) {
  color: #606266;
}
</style>
