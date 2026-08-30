import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THINKING_LEVEL_OPTIONS,
  THINKING_STRENGTH_LEVELS,
  normalizeThinkingLevels,
  thinkingCapabilityFor,
  thinkingOptionsFromLevels,
} from './thinkingLevels.js';

test('normalizeThinkingLevels: 过滤未知/off、小写归一、按全集顺序输出；非数组返回空', () => {
  assert.deepEqual(normalizeThinkingLevels(['MAX', 'low', 'off', 'on', 'bogus', 'high', 'high']), ['low', 'high', 'max']);
  assert.deepEqual(normalizeThinkingLevels([]), []);
  assert.deepEqual(normalizeThinkingLevels('low'), []);
  assert.deepEqual(normalizeThinkingLevels(null), []);
});

test('thinkingCapabilityFor: descriptor 档位直通；模型级子集替换强度档位（effort）或升级 toggle 为分级、off 恒在', () => {
  const provider = (thinking, models) => ({ thinking, models });
  // effort 形状 + deepseek 风格子集
  assert.deepEqual(
    thinkingCapabilityFor(
      provider({ kind: 'effort', levels: ['off', 'minimal', 'low', 'medium', 'high'] }, [{ name: 'deepseek-v3.1', thinking_levels: ['low', 'high', 'max'] }]),
      'deepseek-v3.1',
    ),
    { kind: 'effort', levels: ['off', 'low', 'high', 'max'] },
  );
  // 无子集/模型未匹配 → descriptor 原样
  assert.deepEqual(
    thinkingCapabilityFor(provider({ kind: 'effort', levels: ['off', 'low', 'high'] }, [{ name: 'm' }]), 'm'),
    { kind: 'effort', levels: ['off', 'low', 'high'] },
  );
  assert.deepEqual(
    thinkingCapabilityFor(provider({ kind: 'effort', levels: ['off', 'low', 'high'] }, []), 'unknown'),
    { kind: 'effort', levels: ['off', 'low', 'high'] },
  );
  // toggle 厂商 + 模型自带 effort 值域 → 升级为 effort 分级（智谱 glm-5.3 场景）
  assert.deepEqual(
    thinkingCapabilityFor(provider({ kind: 'toggle', levels: ['off', 'on'] }, [{ name: 'glm-5.3', thinking_levels: ['low', 'high', 'max'] }]), 'glm-5.3'),
    { kind: 'effort', levels: ['off', 'low', 'high', 'max'] },
  );
  // toggle 无子集 → 维持开关档位
  assert.deepEqual(
    thinkingCapabilityFor(provider({ kind: 'toggle', levels: ['off', 'on'] }, [{ name: 'glm-5' }]), 'glm-5'),
    { kind: 'toggle', levels: ['off', 'on'] },
  );
  // budget / none：子集（effort 语义）不影响
  assert.deepEqual(
    thinkingCapabilityFor(provider({ kind: 'budget', levels: ['off', 'low', 'medium', 'high'] }, [{ name: 'claude', thinking_levels: ['low'] }]), 'claude'),
    { kind: 'budget', levels: ['off', 'low', 'medium', 'high'] },
  );
  assert.deepEqual(thinkingCapabilityFor(provider(null, []), 'm'), { kind: 'none', levels: [] });
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

test('强度档位全集与 agent-llm THINKING_STRENGTH_LEVELS 一致（off 不入子集）', () => {
  assert.deepEqual(THINKING_STRENGTH_LEVELS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});
