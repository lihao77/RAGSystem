/** 通用 Artifact API。 */

import { http } from './http.js';

const BASE = '/api/artifacts';

/** 获取通用 Artifact descriptor；实际展示器由 viz_type 决定。 */
export async function getArtifact(artifactId) {
  return http.get(`${BASE}/${encodeURIComponent(artifactId)}`);
}

/** 获取受会话鉴权保护的 Artifact 二进制内容及响应头。 */
export async function getArtifactContent(artifactId, options = {}) {
  return http.getRaw(`${BASE}/${encodeURIComponent(artifactId)}/content`, {
    responseType: 'blob',
    signal: options.signal,
  });
}
