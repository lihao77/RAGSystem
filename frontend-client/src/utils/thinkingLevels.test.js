import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THINKING_KINDS_BY_FORMAT,
  THINKING_LEVEL_OPTIONS,
  THINKING_STRENGTH_LEVELS,
  normalizeThinkingLevels,
  thinkingCapabilityFor,
  thinkingKindOptions,
  thinkingOptionsFromLevels,
} from './thinkingLevels.js';

test('normalizeThinkingLevels: 过滤未知/off、小写归一、按全集顺序输出；非数组返回空', () => {
  assert.deepEqual(normalizeThinkingLevels(['MAX', 'low', 'off', 'on', 'bogus', 'high', 'high']), ['low', 'high', 'max']);
  assert.deepEqual(normalizeThinkingLevels([]), []);
  assert.deepEqual(normalizeThinkingLevels('low'), []);
  assert.deepEqual(normalizeThinkingLevels(null), []);
});

test('thinkingKindOptions: 格式能力矩阵过滤；目录推荐打 ★、可接受集标记（用户可改选）', () => {
  // anthropic 线：budget/effort/none（无 toggle 通道）
  const anthropic = thinkingKindOptions('anthropic', ['toggle', 'budget'], 'budget');
  assert.deepEqual(anthropic.map((option) => option.value), ['budget', 'effort', 'none']);
  assert.equal(anthropic[0].label, '★ budget · token 预算');
  assert.equal(anthropic[0].recommended, true);
  assert.equal(anthropic[0].catalogAccepted, true);
  // 目录声明 toggle 但 anthropic 线不可达：被矩阵滤掉，不出现
  assert.equal(anthropic.some((option) => option.value === 'toggle'), false);
  assert.equal(anthropic[1].catalogAccepted, false);
  // openai 线：effort/toggle/none（无 budget 通道）
  const openai = thinkingKindOptions('openai_chat', ['effort', 'toggle'], 'effort');
  assert.deepEqual(openai.map((option) => option.value), ['effort', 'toggle', 'none']);
  assert.equal(openai[0].label, '★ effort · 推理档位');
  // 自定义模型（无目录信息）：全集无推荐标
  const custom = thinkingKindOptions('openai_chat', [], null);
  assert.deepEqual(custom.map((option) => option.value), ['effort', 'toggle', 'none']);
  assert.equal(custom.some((option) => option.recommended), false);
  // gemini 恒 none；未知格式空集
  assert.deepEqual(thinkingKindOptions('gemini').map((option) => option.value), ['none']);
  assert.deepEqual(thinkingKindOptions('vertex'), []);
});

test('thinkingCapabilityFor: 直读模型条目 descriptor（后端逐模型注入，无前端推断）', () => {
  const provider = (models) => ({ models });
  // effort 形状 + 子集（descriptor 已含子集收缩，后端 describeThinking 产出）
  assert.deepEqual(
    thinkingCapabilityFor(
      provider([{ name: 'deepseek-v3.1', thinking: { kind: 'effort', levels: ['off', 'low', 'high', 'max'] } }]),
      'deepseek-v3.1',
    ),
    { kind: 'effort', levels: ['off', 'low', 'high', 'max'] },
  );
  // toggle 形状（无分级）与 none（无菜单）
  assert.deepEqual(
    thinkingCapabilityFor(provider([{ name: 'glm-5', thinking: { kind: 'toggle', levels: ['off', 'on'] } }]), 'glm-5'),
    { kind: 'toggle', levels: ['off', 'on'] },
  );
  assert.deepEqual(
    thinkingCapabilityFor(provider([{ name: 'm', thinking: { kind: 'none', levels: [] } }]), 'm'),
    { kind: 'none', levels: [] },
  );
  // 无条目匹配 / 无 descriptor / 空模型名 / null provider = 无思考选项
  assert.deepEqual(thinkingCapabilityFor(provider([]), 'm'), { kind: 'none', levels: [] });
  assert.deepEqual(thinkingCapabilityFor(provider([{ name: 'm' }]), 'm'), { kind: 'none', levels: [] });
  assert.deepEqual(thinkingCapabilityFor(provider(null), ''), { kind: 'none', levels: [] });
  assert.deepEqual(thinkingCapabilityFor(null, 'm'), { kind: 'none', levels: [] });
});

test('thinkingOptionsFromLevels: 档位 → 下拉选项（模型默认首位，带档位描述）；未知档位丢弃', () => {
  const byValue = (value) => {
    const option = THINKING_LEVEL_OPTIONS.find((item) => item.value === value);
    return { value: option.value, label: option.label, ...(option.description ? { description: option.description } : {}) };
  };
  assert.deepEqual(thinkingOptionsFromLevels(['off', 'low', 'high', 'max']), [
    { value: '', label: '模型默认' },
    byValue('off'),
    byValue('low'),
    byValue('high'),
    byValue('max'),
  ]);
  assert.deepEqual(thinkingOptionsFromLevels([]), [{ value: '', label: '模型默认' }]);
  assert.deepEqual(thinkingOptionsFromLevels('low'), [{ value: '', label: '模型默认' }]);
});

test('强度档位全集与 agent-llm THINKING_STRENGTH_LEVELS 一致（off 不入子集）；形状能力矩阵同构', () => {
  assert.deepEqual(THINKING_STRENGTH_LEVELS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(THINKING_KINDS_BY_FORMAT, {
    anthropic: ['budget', 'effort', 'none'],
    openai_chat: ['effort', 'toggle', 'none'],
    openai_resp: ['effort', 'toggle', 'none'],
    gemini: ['none'],
  });
});
