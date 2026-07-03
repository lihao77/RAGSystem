/**
 * 可视化/产物 API。
 * 收敛聊天 composables/components 原本散落的 /api/artifacts/* 请求。
 */

import { http } from './http.js';

const BASE = '/api/artifacts';

/** 获取可视化数据（viz_type: chart/map/image，及 config）。 */
export async function getVisualization(artifactId) {
  return http.get(`${BASE}/visualizations/${encodeURIComponent(artifactId)}`);
}
