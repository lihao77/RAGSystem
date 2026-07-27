import test from 'node:test';
import assert from 'node:assert/strict';

import { http } from '../api/http.js';
import { isAuthenticatedApiUrl, resolveAuthenticatedMediaUrl } from './authenticatedMedia.js';

test('isAuthenticatedApiUrl 仅识别需要 Bearer token 的同源 API 图片', () => {
  assert.equal(isAuthenticatedApiUrl('/api/agent/sessions/s1/files/f1/download'), true);
  assert.equal(isAuthenticatedApiUrl('blob:local-preview'), false);
  assert.equal(isAuthenticatedApiUrl('data:image/png;base64,AQID'), false);
  assert.equal(isAuthenticatedApiUrl('/static/example.png'), false);
  assert.equal(isAuthenticatedApiUrl('https://cdn.example.com/example.png'), false);
});

test('resolveAuthenticatedMediaUrl 通过统一 HTTP client 获取 Blob 并释放对象 URL', async () => {
  const originalGetRaw = http.getRaw;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const calls = [];

  http.getRaw = async (url, options) => {
    calls.push({ url, options });
    return { data: new Blob(['image'], { type: 'image/png' }) };
  };
  URL.createObjectURL = () => 'blob:authenticated-preview';
  URL.revokeObjectURL = (url) => calls.push({ revoked: url });

  try {
    const resolved = await resolveAuthenticatedMediaUrl('/api/protected.png');
    assert.equal(resolved.src, 'blob:authenticated-preview');
    assert.equal(calls[0].url, '/api/protected.png');
    assert.equal(calls[0].options.responseType, 'blob');

    resolved.release();
    resolved.release();
    assert.deepEqual(calls.filter(item => item.revoked), [{ revoked: 'blob:authenticated-preview' }]);
  } finally {
    http.getRaw = originalGetRaw;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test('resolveAuthenticatedMediaUrl 保持本地预览 URL 直连', async () => {
  const resolved = await resolveAuthenticatedMediaUrl('blob:local-preview');
  assert.equal(resolved.src, 'blob:local-preview');
});
