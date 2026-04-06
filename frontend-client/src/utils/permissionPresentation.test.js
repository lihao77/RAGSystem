import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getApprovalReasonLabels,
  getApprovalReasonText,
  getPermissionModeLabel,
  getPermissionModeMeta,
  SKIP_ALL_APPROVALS_META,
} from './permissionPresentation.js';

test('dangerously_skip_permissions 显示为跳过审批', () => {
  assert.equal(getPermissionModeLabel('dangerously_skip_permissions'), '跳过审批');
  assert.equal(getPermissionModeMeta('dangerously_skip_permissions')?.desc, '跳过常规风险审批；路径越界等 ask 仍可能触发');
});

test('approval_reason 存在时返回可展示文本', () => {
  assert.equal(getApprovalReasonText('标准模式：high 风险工具需要审批'), '标准模式：high 风险工具需要审批');
});

test('approval_reason 缺省时保持兼容', () => {
  assert.equal(getApprovalReasonText(undefined), '');
  assert.equal(getApprovalReasonText(''), '');
});

test('approval_reason_codes 可映射为双重展示标签', () => {
  assert.deepEqual(getApprovalReasonLabels(['ask-risk', 'ask-path']), ['风险审批', '路径越界审批']);
  assert.deepEqual(getApprovalReasonLabels(['ask-path']), ['路径越界审批']);
  assert.deepEqual(getApprovalReasonLabels([]), []);
});

test('skip_all_approvals 文案可展示', () => {
  assert.equal(SKIP_ALL_APPROVALS_META.label, '跳过所有审批');
  assert.match(SKIP_ALL_APPROVALS_META.desc, /路径越界/);
});
