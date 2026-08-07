/** 通用 Artifact API。 */

import { http } from './http.js';

const BASE = '/api/artifacts';

/** 获取 V2 Artifact Manifest；图表读取 presentation，空间数据由地图宿主工具读取 Asset。 */
export async function getArtifact(artifactId) {
  return http.get(`${BASE}/${encodeURIComponent(artifactId)}`);
}

/** 获取受会话鉴权保护的 V2 Asset 二进制内容及响应头。 */
export async function getArtifactAssetContent(artifactId, assetId, options = {}) {
  return http.getRaw(`${BASE}/${encodeURIComponent(artifactId)}/assets/${encodeURIComponent(assetId)}/content`, {
    responseType: 'blob',
    signal: options.signal,
  });
}
