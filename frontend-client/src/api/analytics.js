/**
 * 管理中心数据分析 API 模块。
 * 对应后端 routes/agent/analytics.ts 的三个聚合端点(基于 agent_call_metrics 明细)。
 */
import { http } from './http.js';

const API_BASE = '/api/agent';

/**
 * 获取 token 用量时间序列。
 * @param {Object} opts
 * @param {number} [opts.days=7] 时间范围天数
 * @param {'day'|'hour'} [opts.bucket='day'] 聚合桶粒度
 * @returns {Promise<Array<{ts:string,token_in:number,token_out:number,calls:number}>>}
 */
export async function getTokenTrend({ days = 7, bucket = 'day' } = {}) {
  try {
    const result = await http.get(
      `${API_BASE}/analytics/token-trend?days=${days}&bucket=${bucket}`,
    );
    return result.data || result;
  } catch (error) {
    console.error('Error fetching token trend:', error);
    throw error;
  }
}

/**
 * 获取模型用量分布(model 为 NULL 的历史行归"未知")。
 * @param {Object} opts
 * @param {number} [opts.days=7]
 * @returns {Promise<Array<{model:string,tokens:number,calls:number}>>}
 */
export async function getModelUsage({ days = 7 } = {}) {
  try {
    const result = await http.get(`${API_BASE}/analytics/model-usage?days=${days}`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching model usage:', error);
    throw error;
  }
}

/**
 * 获取活跃度热力图(星期×小时稀疏点,前端补全 7×24 网格)。
 * @param {Object} opts
 * @param {number} [opts.days=90]
 * @returns {Promise<Array<{weekday:number,hour:number,calls:number}>>}
 */
export async function getActivityHeatmap({ days = 90 } = {}) {
  try {
    const result = await http.get(`${API_BASE}/analytics/activity-heatmap?days=${days}`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching activity heatmap:', error);
    throw error;
  }
}

/**
 * 获取每日活跃度(GitHub 式日历热力图,date=YYYY-MM-DD)。
 * @param {Object} opts
 * @param {number} [opts.days=180]
 * @returns {Promise<Array<{date:string,calls:number}>>}
 */
export async function getDailyActivity({ days = 180 } = {}) {
  try {
    const result = await http.get(`${API_BASE}/analytics/daily-activity?days=${days}`);
    return result.data || result;
  } catch (error) {
    console.error('Error fetching daily activity:', error);
    throw error;
  }
}
