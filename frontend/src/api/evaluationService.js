/**
 * 知识图谱评估服务
 * 提供与知识图谱评估相关的API接口
 */

import { get, post } from './http';

/**
 * 评估服务
 */
export const evaluationService = {
  /**
   * 获取可用于评估的文档列表
   * @returns {Promise<Array>} 文档列表
   */
  async getAvailableDocuments() {
    try {
      const response = await get('/api/evaluation/documents');
      return response;
    } catch (error) {
      console.error('获取可用文档失败:', error);
      throw new Error('获取可用文档失败');
    }
  },

  /**
   * 生成评估样本
   * @param {Object} params 生成样本的参数
   * @param {string} params.evaluationType 评估类型 (accuracy, recall, comprehensive)
   * @param {string} params.samplingMethod 抽样方法 (random, document, entity)
   * @param {number} params.sampleSize 样本数量
   * @param {Array<string>} [params.documentIds] 文档ID列表 (按文档抽取时使用)
   * @param {Array<string>} [params.entityTypes] 实体类型列表 (按实体类型抽取时使用)
   * @returns {Promise<Array>} 评估样本列表
   */
  async generateSamples(params) {
    try {
      const response = await post(`/evaluation/generate-samples`, params);
      return response;
    } catch (error) {
      console.error('生成评估样本失败:', error);
      throw new Error('生成评估样本失败');
    }
  },

  /**
   * 保存样本标注
   * @param {Object} annotation 标注数据
   * @param {string} annotation.sampleId 样本ID
   * @param {Array} annotation.entities 实体标注
   * @param {Array} annotation.relations 关系标注
   * @param {Array} annotation.missingEntities 漏检实体
   * @param {Array} annotation.missingRelations 漏检关系
   * @returns {Promise<Object>} 保存结果
   */
  async saveSampleAnnotation(annotation) {
    try {
      const response = await post(`/api/evaluation/save-annotation`, annotation);
      return response;
    } catch (error) {
      console.error('保存样本标注失败:', error);
      throw new Error('保存样本标注失败');
    }
  },

  /**
   * 计算评估指标
   * @param {Object} params 计算参数
   * @param {Array} params.samples 已标注的样本
   * @param {string} params.evaluationType 评估类型
   * @returns {Promise<Object>} 评估指标和详细结果
   */
  async calculateMetrics(params) {
    try {
      const response = await post(`/api/evaluation/calculate-metrics`, params);
      return response;
    } catch (error) {
      console.error('计算评估指标失败:', error);
      throw new Error('计算评估指标失败');
    }
  },

  /**
   * 导出评估报告
   * @param {Object} params 报告参数
   * @param {Array} params.samples 已标注的样本
   * @param {Object} params.metrics 评估指标
   * @param {Array} params.entityResults 实体评估结果
   * @param {Array} params.relationResults 关系评估结果
   * @param {Array} params.commonErrors 常见错误
   * @returns {Promise<string>} 报告下载URL
   */
  async exportEvaluationReport(params) {
    try {
      const response = await post(`/evaluation/export-report`, params);
      return response.reportUrl;
    } catch (error) {
      console.error('导出评估报告失败:', error);
      throw new Error('导出评估报告失败');
    }
  }
};