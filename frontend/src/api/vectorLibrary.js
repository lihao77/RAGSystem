/**
 * 向量库管理 API（插件式向量化器）
 */

import * as http from './http'

const BASE = '/api/vector-library'

export function getFileStatus() {
  return http.get(`${BASE}/file-status`)
}

export function indexFileWithVectorizer(body) {
  return http.post(`${BASE}/index-file`, body)
}

export function deleteFile(body) {
  return http.post(`${BASE}/delete-file`, body)
}

export function listVectorizers() {
  return http.get(`${BASE}/vectorizers`)
}

export function addVectorizer(body) {
  return http.post(`${BASE}/vectorizers`, body)
}

export function activateVectorizer(key) {
  return http.post(`${BASE}/vectorizers/${encodeURIComponent(key)}/activate`)
}

export function listDocsByVectorizer(key, params = {}) {
  const q = new URLSearchParams(params).toString()
  return http.get(`${BASE}/vectorizers/${encodeURIComponent(key)}/docs${q ? `?${q}` : ''}`)
}

export function migrate(body) {
  return http.post(`${BASE}/migrate`, body)
}

export function deleteVectorizer(key) {
  return http.del(`${BASE}/vectorizers/${encodeURIComponent(key)}`)
}
