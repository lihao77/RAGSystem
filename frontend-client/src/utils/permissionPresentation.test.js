import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getApprovalReasonText,
  getPermissionModeLabel,
  getPermissionModeMeta,
} from './permissionPresentation.js';

test('dangerously_skip_permissions 显示为跳过审批', () => {
  assert.equal(getPermissionModeLabel('dangerously_skip_permissions'), '跳过审批');
  assert.equal(getPermissionModeMeta('dangerously_skip_permissions')?.desc, '跳过审批，不再弹出确认');
});

test('approval_reason 存在时返回可展示文本', () => {
  assert.equal(getApprovalReasonText('标准模式：high 风险工具需要审批'), '标准模式：high 风险工具需要审批');
});

test('approval_reason 缺省时保持兼容', () => {
  assert.equal(getApprovalReasonText(undefined), '');
  assert.equal(getApprovalReasonText(''), '');
});
