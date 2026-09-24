<template>
  <div v-if="capability.kind !== 'none'" class="thinking-selector" :title="triggerTitle">
    <Popover v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="thinking-trigger"
          :class="{ open, active: isOverride }"
          :aria-expanded="open"
          role="combobox"
        >
          <IconBrain :size="14" class="brain-icon" :class="{ active: isOverride }" />
          <span class="trigger-label">{{ displayText }}</span>
          <IconChevronDown class="arrow-icon" :class="{ rotate: open }" :size="14" />
        </button>
      </PopoverTrigger>
      <PopoverContent
      class="thinking-popover p-0"
      align="start"
      side="top"
      :side-offset="8"
      @focus-outside.prevent
    >
        <div role="radiogroup" aria-label="思考等级" class="thinking-options">
          <button
            type="button"
            role="radio"
            :aria-checked="!thinkingLevel"
            class="thinking-option"
            :class="{ selected: !thinkingLevel }"
            @click="selectLevel('')"
          >
            <span class="option-copy">
              <span class="option-label">跟随配置</span>
              <span class="option-sub">使用 Provider / 智能体的默认设置</span>
            </span>
            <IconCheck v-if="!thinkingLevel" class="check-icon" :size="16" :stroke-width="2.5" />
          </button>
          <button
            v-for="level in capability.levels"
            :key="level"
            type="button"
            role="radio"
            :aria-checked="thinkingLevel === level"
            class="thinking-option"
            :class="{ selected: thinkingLevel === level }"
            @click="selectLevel(level)"
          >
            <span class="option-copy">
              <span class="option-label">{{ labelFor(level) }}</span>
              <span class="option-sub">{{ descriptionFor(level) }}</span>
            </span>
            <IconCheck v-if="thinkingLevel === level" class="check-icon" :size="16" :stroke-width="2.5" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Brain } from 'lucide-vue-next';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { describeThinkingForModel, findProviderModelByValue } from '../api/modelAdapter';
import { fetchDefaultLlm } from '../api/runtimeCore';
import { useLlmStore } from '../stores/llm.js';
import { useThinkingStore } from '../stores/thinking.js';
import { useSessionRunStore } from '../stores/session-run.js';
import IconChevronDown from './icons/IconChevronDown.vue';
import IconCheck from './icons/IconCheck.vue';

const IconBrain = Brain;

const LEVEL_META = {
  off: { label: '关闭', description: '不进行扩展思考，响应最快' },
  minimal: { label: '最低', description: '最小限度思考，速度优先' },
  low: { label: '低', description: '轻度思考，速度与质量均衡' },
  medium: { label: '中', description: '适度思考，适合常规复杂任务' },
  high: { label: '高', description: '深度思考，适合复杂推理任务' },
  xhigh: { label: '最高', description: '超深度思考，适合高难度推理任务' },
  max: { label: '最大', description: '最大强度思考，适合极限复杂任务' },
  on: { label: '开启', description: '开启思考（该模型无强度分级）' },
};

const llmStore = useLlmStore();
const { selectedLLM } = storeToRefs(llmStore);
const thinkingStore = useThinkingStore();
const { thinkingLevel } = storeToRefs(thinkingStore);
const sessionRunStore = useSessionRunStore();
const { currentSessionTeam, pendingEntryAgent } = storeToRefs(sessionRunStore);

const capability = ref({ kind: 'none', levels: [] });
const open = ref(false);

const displayText = computed(() => (thinkingLevel.value ? labelFor(thinkingLevel.value) : '跟随'));

const triggerTitle = computed(() => {
  const target = selectedLLM.value ? findProviderModelByValue(selectedLLM.value).model : '默认模型';
  return `思考等级（${target || '智能体配置'}）`;
});

const labelFor = (level) => LEVEL_META[level]?.label || level;
const descriptionFor = (level) => LEVEL_META[level]?.description || '';

const selectLevel = (value) => {
  thinkingStore.setThinkingLevel(value);
  open.value = false;
};

// 模型与团队/入口 Agent 切换都会改能力来源；空选择下团队或入口切换换默认模型，
// 同样需要重算。竞态守卫在写入前校验序号：快速连续切换时，旧响应不得覆盖新状态。
let capabilityLoadSeq = 0;
const loadCapability = async () => {
  const seq = ++capabilityLoadSeq;
  // "默认"状态按入口 Agent（会话实际入口或用户选择）默认 tier 解析出的实际模型取
  // 能力（与执行路径同源），解析不出（未配置/接口失败）时保持隐藏；显式选择按所选
  // 模型取能力。
  const defaultLlm = selectedLLM.value
    ? null
    : await fetchDefaultLlm(currentSessionTeam.value, pendingEntryAgent.value);
  const next = await describeThinkingForModel(selectedLLM.value, defaultLlm);
  if (seq !== capabilityLoadSeq) return;
  capability.value = next;
  // 默认态且默认模型解析失败只是暂时拿不到能力（网络抖动/接口异常），不应据此清掉
  // 用户档位；显式模型路径维持失效清理（模型能力是确定事实）。
  if (!selectedLLM.value && !defaultLlm) return;
  // 已保存档位不在当前模型能力集内（模型不支持思考，或开关型存的 on 换到分级模型）
  // 时丢弃覆盖，避免静默携带后端会拒收的档位。会话恢复值失效先清覆盖层，
  // 回落后的个人默认也失效才清全局；走 discardStaleDefault——自动清理不是
  // 用户选择，不得触发"选择即落库"。
  const current = thinkingLevel.value;
  if (!current || next.levels.includes(current)) return;
  thinkingStore.clearSessionOverride();
  const fallback = thinkingLevel.value;
  if (fallback && !next.levels.includes(fallback)) {
    thinkingStore.discardStaleDefault();
  }
};

onMounted(loadCapability);
watch(selectedLLM, loadCapability);
watch([currentSessionTeam, pendingEntryAgent], () => {
  if (!selectedLLM.value) loadCapability();
});
</script>

<style scoped>
.thinking-selector {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.thinking-trigger {
  height: 28px;
  padding: 0 30px 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: var(--control-radius);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  position: relative;
  user-select: none;
  transition: background 0.2s, color 0.2s;
}

.thinking-trigger:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.thinking-trigger.open {
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

/* 聚焦指示改用与 hover 一致的背景；避免点击瞬间轮廓/光圈闪现 */
.thinking-selector .thinking-trigger:focus-visible {
  outline: none;
  box-shadow: none;
  background: var(--color-hover-overlay);
}

.thinking-trigger.active {
  color: var(--color-text-primary);
}

.thinking-trigger.active .brain-icon.active {
  color: var(--color-brand-accent, var(--color-text-primary));
}

.brain-icon {
  flex-shrink: 0;
}

.arrow-icon {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  transition: transform 0.3s;
  pointer-events: none;
}

.arrow-icon.rotate {
  transform: translateY(-50%) rotate(180deg);
}

.trigger-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thinking-popover {
  width: 260px;
  padding: 0;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  box-shadow: var(--shadow-lg);
}

.thinking-options {
  display: flex;
  flex-direction: column;
  padding: 4px;
  gap: 2px;
}

.thinking-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-md, 8px);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.thinking-option:hover {
  background: var(--color-interactive-hover);
}

.thinking-option.selected {
  background: var(--color-interactive-hover);
}

.option-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.option-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
}

.option-sub {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check-icon {
  flex-shrink: 0;
  color: var(--color-success);
}
</style>
