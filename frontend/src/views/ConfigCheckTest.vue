<!-- 
配置检查测试页面
用于测试配置检查功能是否正常工作
-->

<template>
  <div class="config-check-test">
    <el-card class="test-card" shadow="hover">
      <template #header>
        <div class="card-header">
          <h2>配置检查功能测试</h2>
          <p class="subtitle">测试路由守卫和手动检查是否正常工作</p>
        </div>
      </template>

      <!-- 当前配置状态 -->
      <el-alert 
        title="当前配置状态" 
        type="info" 
        :closable="false"
        style="margin-bottom: 20px">
        <div v-if="configStatus">
          <el-tag :type="configStatus.neo4jConfigured ? 'success' : 'danger'" style="margin-right: 10px">
            Neo4j: {{ configStatus.neo4jConfigured ? '✓ 已配置' : '✗ 未配置' }}
          </el-tag>
          <el-tag :type="configStatus.vectorConfigured ? 'success' : 'danger'" style="margin-right: 10px">
            向量库: {{ configStatus.vectorConfigured ? '✓ 已配置' : '✗ 未配置' }}
          </el-tag>
          <el-tag :type="configStatus.llmConfigured ? 'success' : 'danger'">
            LLM: {{ configStatus.llmConfigured ? '✓ 已配置' : '✗ 未配置' }}
          </el-tag>
        </div>
        <div v-else>
          <el-skeleton :rows="1" animated />
        </div>
      </el-alert>

      <!-- 测试按钮组 -->
      <div class="test-actions">
        <h3>手动检查测试</h3>
        <el-space wrap>
          <el-button type="primary" @click="testRequireNeo4j">
            测试 Neo4j 检查
          </el-button>
          <el-button type="success" @click="testRequireVector">
            测试向量库检查
          </el-button>
          <el-button type="warning" @click="testRequireLLM">
            测试 LLM 检查
          </el-button>
          <el-button type="danger" @click="testRequireAll">
            测试全部检查
          </el-button>
        </el-space>

        <h3 style="margin-top: 30px">快速检查测试</h3>
        <el-space wrap>
          <el-button @click="testCheckNeo4j">
            检查 Neo4j 状态
          </el-button>
          <el-button @click="testCheckVector">
            检查向量库状态
          </el-button>
          <el-button @click="testCheckLLM">
            检查 LLM 状态
          </el-button>
          <el-button @click="testCheckAll">
            检查全部状态
          </el-button>
        </el-space>

        <h3 style="margin-top: 30px">缓存管理</h3>
        <el-space wrap>
          <el-button type="info" @click="refreshConfig">
            <el-icon><Refresh /></el-icon>
            刷新配置
          </el-button>
          <el-button type="info" @click="clearCache">
            <el-icon><Delete /></el-icon>
            清除缓存
          </el-button>
        </el-space>
      </div>

      <!-- 测试日志 -->
      <el-divider />
      <div class="test-logs">
        <h3>测试日志</h3>
        <el-timeline>
          <el-timeline-item
            v-for="(log, index) in logs"
            :key="index"
            :timestamp="log.time"
            :type="log.type"
            placement="top">
            {{ log.message }}
          </el-timeline-item>
        </el-timeline>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useConfigCheck } from '@/composables/useConfigCheck'
import { ElMessage } from 'element-plus'
import { Refresh, Delete } from '@element-plus/icons-vue'

const {
  checkConfigStatus,
  requireConfig,
  checkNeo4j,
  checkVector,
  checkLLM,
  checkAllConfigured,
  resetConfigStatusCache
} = useConfigCheck()

const configStatus = ref(null)
const logs = ref([])

// 添加日志
function addLog(message, type = 'primary') {
  logs.value.unshift({
    message,
    type,
    time: new Date().toLocaleTimeString()
  })
}

// 加载配置状态
onMounted(async () => {
  addLog('页面加载，开始检查配置状态...', 'info')
  configStatus.value = await checkConfigStatus()
  addLog('配置状态加载完成', 'success')
})

// 测试 requireConfig - Neo4j
async function testRequireNeo4j() {
  addLog('测试：requireConfig({ neo4j: true })', 'primary')
  const result = await requireConfig({ neo4j: true })
  if (result) {
    addLog('✓ Neo4j 配置检查通过', 'success')
    ElMessage.success('Neo4j 配置完整')
  } else {
    addLog('✗ Neo4j 配置检查失败（用户取消或未配置）', 'warning')
  }
}

// 测试 requireConfig - 向量库
async function testRequireVector() {
  addLog('测试：requireConfig({ vector: true })', 'primary')
  const result = await requireConfig({ vector: true })
  if (result) {
    addLog('✓ 向量库配置检查通过', 'success')
    ElMessage.success('向量库配置完整')
  } else {
    addLog('✗ 向量库配置检查失败（用户取消或未配置）', 'warning')
  }
}

// 测试 requireConfig - LLM
async function testRequireLLM() {
  addLog('测试：requireConfig({ llm: true })', 'primary')
  const result = await requireConfig({ llm: true })
  if (result) {
    addLog('✓ LLM 配置检查通过', 'success')
    ElMessage.success('LLM 配置完整')
  } else {
    addLog('✗ LLM 配置检查失败（用户取消或未配置）', 'warning')
  }
}

// 测试 requireConfig - 全部
async function testRequireAll() {
  addLog('测试：requireConfig({ neo4j: true, vector: true, llm: true })', 'primary')
  const result = await requireConfig({ 
    neo4j: true, 
    vector: true, 
    llm: true 
  })
  if (result) {
    addLog('✓ 全部配置检查通过', 'success')
    ElMessage.success('所有配置都完整')
  } else {
    addLog('✗ 配置检查失败（用户取消或有未配置项）', 'warning')
  }
}

// 测试 checkNeo4j
async function testCheckNeo4j() {
  addLog('测试：checkNeo4j()', 'primary')
  const result = await checkNeo4j()
  addLog(`Neo4j 配置状态: ${result ? '已配置' : '未配置'}`, result ? 'success' : 'danger')
  ElMessage({
    message: `Neo4j ${result ? '已配置' : '未配置'}`,
    type: result ? 'success' : 'warning'
  })
}

// 测试 checkVector
async function testCheckVector() {
  addLog('测试：checkVector()', 'primary')
  const result = await checkVector()
  addLog(`向量库配置状态: ${result ? '已配置' : '未配置'}`, result ? 'success' : 'danger')
  ElMessage({
    message: `向量库 ${result ? '已配置' : '未配置'}`,
    type: result ? 'success' : 'warning'
  })
}

// 测试 checkLLM
async function testCheckLLM() {
  addLog('测试：checkLLM()', 'primary')
  const result = await checkLLM()
  addLog(`LLM 配置状态: ${result ? '已配置' : '未配置'}`, result ? 'success' : 'danger')
  ElMessage({
    message: `LLM ${result ? '已配置' : '未配置'}`,
    type: result ? 'success' : 'warning'
  })
}

// 测试 checkAllConfigured
async function testCheckAll() {
  addLog('测试：checkAllConfigured()', 'primary')
  const result = await checkAllConfigured()
  addLog(`全部配置状态: ${result ? '全部已配置' : '有未配置项'}`, result ? 'success' : 'danger')
  ElMessage({
    message: result ? '所有配置都完整' : '存在未配置项',
    type: result ? 'success' : 'warning'
  })
}

// 刷新配置
async function refreshConfig() {
  addLog('刷新配置状态（强制刷新）...', 'info')
  configStatus.value = await checkConfigStatus(true)
  addLog('配置状态已刷新', 'success')
  ElMessage.success('配置已刷新')
}

// 清除缓存
function clearCache() {
  addLog('清除配置缓存...', 'info')
  resetConfigStatusCache()
  configStatus.value = null
  addLog('配置缓存已清除，下次检查将重新请求', 'success')
  ElMessage.success('缓存已清除')
  
  // 重新加载
  setTimeout(async () => {
    configStatus.value = await checkConfigStatus()
  }, 500)
}
</script>

<style scoped>
.config-check-test {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
}

.test-card {
  margin-bottom: 20px;
}

.card-header h2 {
  margin: 0;
  font-size: 24px;
}

.subtitle {
  margin: 5px 0 0 0;
  color: #909399;
  font-size: 14px;
}

.test-actions {
  margin-top: 20px;
}

.test-actions h3 {
  margin-bottom: 15px;
  font-size: 16px;
  color: #303133;
}

.test-logs {
  margin-top: 20px;
  max-height: 400px;
  overflow-y: auto;
}

.test-logs h3 {
  margin-bottom: 15px;
  font-size: 16px;
  color: #303133;
}
</style>
