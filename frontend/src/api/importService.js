/**
 * 数据导入相关API服务
 */

import { get, post, postFormData } from './http';
import axios from 'axios';

/**
 * 扫描指定目录下的文档文件
 * @param {string} path - 目录路径
 * @returns {Promise<Array>} 文件列表
 */
export async function scanDirectory(path) {
  return await post('/api/import/scan-directory', { path });
}

/**
 * 上传文件进行处理
 * @param {FormData} formData - 包含文件的FormData对象
 * @returns {Promise<object>} 上传结果
 */
export async function uploadFiles(formData) {
  try {
    // 使用专门的FormData上传函数
    const response = await postFormData('/api/import/upload', formData);
    return response;
  } catch (error) {
    console.error('文件上传错误:', error);
    throw error;
  }
}

/**
 * 开始处理文件
 * @param {Array} files - 要处理的文件列表
 * @param {object} options - 处理选项
 * @returns {Promise<object>} 处理结果
 */
export async function processFiles(files, options) {
  return await post('/api/import/process', { files, options });
}

/**
 * 获取处理进度
 * @param {string} taskId - 任务ID
 * @returns {Promise<object>} 处理进度信息
 */
export async function getProcessingStatus(taskId) {
  return await get(`/api/import/status/${taskId}`);
}

/**
 * 取消处理任务
 * @param {string} taskId - 任务ID
 * @returns {Promise<object>} 取消结果
 */
export async function cancelProcessing(taskId) {
  return await post('/api/import/cancel', { taskId });
}

/**
 * 获取系统设置
 * @returns {Promise<object>} 系统设置信息
 */
export async function getSystemSettings() {
  return await get('/api/settings');
}

/**
 * 获取处理历史记录
 * @returns {Promise<Array>} 历史记录列表
 */
export async function getProcessingHistory() {
  return await get('/api/import/history');
}