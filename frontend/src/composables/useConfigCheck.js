/**
 * 配置状态检查 Composable
 * 用于检查系统配置状态，并在未配置时提示用户
 */

import { ref } from 'vue'
import { ElMessageBox, ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import * as configApi from '@/api/config'

// 全局配置状态缓存
const configStatusCache = ref({
  checked: false,
  neo4jConfigured: false,
  vectorConfigured: false,
  llmConfigured: false,
  lastCheckTime: null
})

/**
 * 检查配置状态
 * @param {boolean} forceRefresh - 是否强制刷新缓存
 * @returns {Promise<Object>} 配置状态对象
 */
export async function checkConfigStatus(forceRefresh = false) {
  // 如果已检查且未超过30秒，返回缓存
  if (!forceRefresh && configStatusCache.value.checked) {
    const now = Date.now()
    const lastCheck = configStatusCache.value.lastCheckTime
    if (lastCheck && (now - lastCheck) < 30 * 1000) {  // 改为30秒
      return configStatusCache.value
    }
  }

  try {
    // 调用后端接口获取服务状态
    const response = await configApi.getServicesStatus()
    
    if (response.success && response.data) {
      const services = response.data.services || []
      
      // 提取各服务状态
      const neo4jService = services.find(s => s.name === 'Neo4j')
      const vectorService = services.find(s => s.name === '向量数据库')
      const llmService = services.find(s => s.name === 'LLM')
      
      configStatusCache.value = {
        checked: true,
        neo4jConfigured: neo4jService?.configured || false,
        vectorConfigured: vectorService?.configured || false,
        llmConfigured: llmService?.configured || false,
        lastCheckTime: Date.now(),
        services: services
      }
    }
    
    return configStatusCache.value
  } catch (error) {
    console.error('检查配置状态失败:', error)
    // 失败时也返回缓存，但标记为未检查
    return {
      checked: false,
      neo4jConfigured: false,
      vectorConfigured: false,
      llmConfigured: false,
      error: error.message
    }
  }
}

/**
 * 重置配置状态缓存
 */
export function resetConfigStatusCache() {
  configStatusCache.value = {
    checked: false,
    neo4jConfigured: false,
    vectorConfigured: false,
    llmConfigured: false,
    lastCheckTime: null
  }
}

/**
 * 使用配置检查的 Hook
 */
export function useConfigCheck() {
  const router = useRouter()

  /**
   * 检查是否需要配置
   * @param {Object} requirements - 需求对象 { neo4j: true, vector: true, llm: true }
   * @returns {Promise<boolean>} 是否已配置
   */
  const requireConfig = async (requirements = {}) => {
    const status = await checkConfigStatus()
    
    // 检查各项要求
    const missingItems = []
    
    if (requirements.neo4j && !status.neo4jConfigured) {
      missingItems.push('Neo4j 数据库')
    }
    
    if (requirements.vector && !status.vectorConfigured) {
      missingItems.push('向量数据库（嵌入模型）')
    }
    
    if (requirements.llm && !status.llmConfigured) {
      missingItems.push('LLM API')
    }
    
    // 如果有缺失项，弹出提示
    if (missingItems.length > 0) {
      try {
        await ElMessageBox.confirm(
          `当前功能需要以下配置才能使用：\n\n${missingItems.map(item => `• ${item}`).join('\n')}\n\n是否立即前往配置页面？`,
          '系统配置不完整',
          {
            type: 'warning',
            confirmButtonText: '前往配置',
            cancelButtonText: '取消',
            distinguishCancelAndClose: true,
            closeOnClickModal: false
          }
        )
        
        // 用户点击确定，跳转到设置页
        router.push('/settings')
        return false
      } catch (error) {
        // 用户点击取消或关闭
        if (error === 'cancel' || error === 'close') {
          ElMessage.info('已取消')
          return false
        }
        throw error
      }
    }
    
    return true
  }

  /**
   * 快速检查单个服务
   */
  const checkNeo4j = async () => {
    const status = await checkConfigStatus()
    return status.neo4jConfigured
  }

  const checkVector = async () => {
    const status = await checkConfigStatus()
    return status.vectorConfigured
  }

  const checkLLM = async () => {
    const status = await checkConfigStatus()
    return status.llmConfigured
  }

  /**
   * 检查所有配置
   */
  const checkAllConfigured = async () => {
    const status = await checkConfigStatus()
    return status.neo4jConfigured && status.vectorConfigured && status.llmConfigured
  }

  return {
    checkConfigStatus,
    requireConfig,
    checkNeo4j,
    checkVector,
    checkLLM,
    checkAllConfigured,
    resetConfigStatusCache
  }
}
