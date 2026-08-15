<!-- eslint-disable vue/no-mutating-props -- 表单模型由父级 useAgentForm 持有，面板直接改写共享 form/tier 对象（有意的表单模型架构） -->
<template>
  <div class="agent-form">
    <!-- 基础信息 -->
    <PanelFormShell title="基础信息" subtitle="展示与启用状态">
      <FieldGroup>
        <div class="form-grid">
          <Field>
            <FieldLabel>显示名称</FieldLabel>
            <Input v-model="form.display_name" type="text" />
          </Field>
          <Field>
            <FieldLabel>标识</FieldLabel>
            <span class="form-static">{{ agentName || form.agent_name || '—' }}</span>
          </Field>
        </div>
        <Field>
          <FieldLabel>描述</FieldLabel>
          <Textarea v-model="form.description" class="description-input" placeholder="可选，简述该 Agent 的职责" />
        </Field>
        <div class="switch-list">
          <SwitchRow label="启用该 Agent" :checked="form.enabled" @update:checked="form.enabled = $event" />
          <SwitchRow label="设为 Team 入口" :checked="form.default_entry" @update:checked="form.default_entry = $event" />
        </div>
      </FieldGroup>
    </PanelFormShell>

    <!-- 模型 -->
    <PanelFormShell title="模型" subtitle="default 必配，fast / powerful 可选">
      <TierFields
        tier-name="default"
        title="default"
        subtitle="主 ReAct 推理默认层（必配）"
        :tier="form.llm_tiers.default"
        :provider-options="providerOptions"
        :provider-key="getTierProviderKey('default')"
        :model-options="getTierModelOptions('default')"
        @provider-change="handleTierProviderChange('default', $event)"
      />
      <TierFields
        v-for="tier in ['fast', 'powerful']"
        :key="tier"
        :tier-name="tier"
        :title="tier"
        :subtitle="tier === 'fast' ? '简单任务（压缩、格式化等），成本优化' : '复杂推理任务（可选）'"
        collapsible
        :enabled="!!form.llm_tiers[tier]"
        :tier="form.llm_tiers[tier]"
        :provider-options="providerOptions"
        :provider-key="getTierProviderKey(tier)"
        :model-options="getTierModelOptions(tier)"
        @toggle="form.llm_tiers[tier] = form.llm_tiers[tier] ? null : createEmptyLLM()"
        @provider-change="handleTierProviderChange(tier, $event)"
      />
    </PanelFormShell>

    <!-- 系统提示词 -->
    <PanelFormShell title="系统提示词" subtitle="custom_params.behavior.system_prompt">
      <Textarea
        v-model="form.custom_params.behavior.system_prompt"
        class="system-prompt-input"
        placeholder="请输入该 Agent 的 system prompt"
      />
    </PanelFormShell>

    <!-- 工具 -->
    <PanelFormShell title="工具" subtitle="选择当前 Agent 可使用的工具能力">
      <CheckGrid
        icon="Wrench"
        :items="tools.map((t) => ({ key: t.name, label: t.display_name || t.name, title: t.description || t.name }))"
        :selected="form.tools.enabled_tools"
        @toggle="(name) => toggleListItem(form.tools.enabled_tools, name)"
      />
    </PanelFormShell>

    <!-- Goal / 后台任务 -->
    <PanelFormShell title="Goal / 后台任务" subtitle="Goal 与后台任务能力">
      <div class="switch-list">
        <SwitchRow
          icon="Goal"
          label="goal mode"
          hint="暴露 goal_create / goal_get / goal_update / goal_list，用于持久目标编排与状态追踪"
          :checked="form.goals.enabled"
          @update:checked="form.goals.enabled = $event"
        />
        <SwitchRow
          icon="Layers"
          label="background"
          hint="暴露 task_output / task_stop，用于后台任务查询、显式等待与停止"
          :checked="form.tasks.background"
          @update:checked="form.tasks.background = $event"
        />
      </div>
    </PanelFormShell>

    <!-- 委派 -->
    <PanelFormShell title="委派" subtitle="当前 Agent 可委派给同 Team 的其他 Agent">
      <CheckGrid
        icon="Users"
        :items="peerAgents.map((a) => ({ key: a, label: displayMap[a] || a, title: a }))"
        :selected="form.delegation.enabled_agents"
        empty-text="当前 Team 没有可委派的其他 Agent。"
        @toggle="(name) => toggleListItem(form.delegation.enabled_agents, name)"
      />
    </PanelFormShell>
  </div>
</template>

<script setup>
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import TierFields from './TierFields.vue';
import PanelFormShell from './PanelFormShell.vue';
import SwitchRow from './SwitchRow.vue';
import CheckGrid from './CheckGrid.vue';
import { createEmptyLLM } from './agentFormModel.js';
import { useTierModels } from '../../composables/agent-studio/useTierModels.js';
import { toggleListItem } from '../../utils/listToggle.js';

const props = defineProps({
  form: { type: Object, required: true },
  agentName: { type: String, default: '' },
  tools: { type: Array, default: () => [] },
  peerAgents: { type: Array, default: () => [] },
  displayMap: { type: Object, default: () => ({}) },
  providerOptions: { type: Array, default: () => [] },
  providers: { type: Array, default: () => [] },
});

// form/providers 用 getter 传入：applyConfig 会整体替换 form 对象，需每次取最新引用
const { getTierProviderKey, getTierModelOptions, handleTierProviderChange } = useTierModels({
  form: () => props.form,
  providers: () => props.providers,
});
</script>

<style scoped>
.agent-form { display: flex; flex-direction: column; gap: var(--spacing-xl); }
.system-prompt-input { min-height: 180px; resize: vertical; font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: 1.6; }
.description-input { min-height: 64px; resize: vertical; }
</style>
