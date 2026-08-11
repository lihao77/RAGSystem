<template>
  <div class="agent-form">
    <!-- 基础信息 -->
    <section class="form-section">
      <div class="section-head"><h2>基础信息</h2><span>展示与启用状态</span></div>
      <div class="section-body">
        <FieldGroup>
          <div class="form-grid">
            <Field>
              <FieldLabel>显示名称</FieldLabel>
              <Input v-model="form.display_name" type="text" />
            </Field>
            <Field>
              <FieldLabel>标识</FieldLabel>
              <Input :value="agentName || form.agent_name" type="text" disabled />
            </Field>
          </div>
          <Field>
            <FieldLabel>描述</FieldLabel>
            <Input v-model="form.description" type="text" />
          </Field>
          <div class="switch-list">
            <div class="switch-row">
              <span class="switch-row__label">启用该 Agent</span>
              <Switch v-model:checked="form.enabled" />
            </div>
            <div class="switch-row">
              <span class="switch-row__label">设为 Team 默认入口</span>
              <Switch v-model:checked="form.default_entry" />
            </div>
          </div>
        </FieldGroup>
      </div>
    </section>

    <!-- 模型 -->
    <section class="form-section">
      <div class="section-head">
        <h2>模型</h2><span>default 必配，fast / powerful 可选</span>
      </div>
      <div class="section-body">
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
      </div>
    </section>

    <!-- 系统提示词 -->
    <section class="form-section">
      <div class="section-head"><h2>系统提示词</h2><span>custom_params.behavior.system_prompt</span></div>
      <div class="section-body">
        <FieldGroup>
          <Field>
            <Textarea
              v-model="form.custom_params.behavior.system_prompt"
              class="system-prompt-input"
              placeholder="请输入该 Agent 的 system prompt"
            />
          </Field>
        </FieldGroup>
      </div>
    </section>

    <!-- 工具 -->
    <section class="form-section">
      <div class="section-head"><h2>工具</h2><span>选择当前 Agent 可使用的工具能力</span></div>
      <div class="section-body">
        <div class="check-grid">
          <label
            v-for="tool in tools"
            :key="tool.name"
            class="check-item"
            :title="tool.description || tool.name"
          >
            <input
              type="checkbox"
              :checked="form.tools.enabled_tools.includes(tool.name)"
              @change="toggleInList(form.tools.enabled_tools, tool.name)"
            />
            <span class="check-item__text">{{ tool.display_name || tool.name }}</span>
          </label>
        </div>
      </div>
    </section>

    <!-- Goal / 后台任务 -->
    <section class="form-section">
      <div class="section-head"><h2>Goal / 后台任务</h2><span>Goal 与后台任务能力</span></div>
      <div class="section-body">
        <div class="switch-list">
          <div class="switch-row">
            <div class="switch-row__copy">
              <span class="switch-row__label">goal mode</span>
              <span class="switch-row__hint">暴露 goal_create / goal_get / goal_update / goal_list，用于持久目标编排与状态追踪</span>
            </div>
            <Switch v-model:checked="form.goals.enabled" />
          </div>
          <div class="switch-row">
            <div class="switch-row__copy">
              <span class="switch-row__label">background</span>
              <span class="switch-row__hint">暴露 task_output / task_stop，用于后台任务查询、显式等待与停止</span>
            </div>
            <Switch v-model:checked="form.tasks.background" />
          </div>
        </div>
      </div>
    </section>

    <!-- 委派 -->
    <section class="form-section">
      <div class="section-head"><h2>委派</h2><span>当前 Agent 可委派给同 Team 的其他 Agent</span></div>
      <div class="section-body">
        <div v-if="peerAgents.length" class="check-grid">
          <label
            v-for="agent in peerAgents"
            :key="agent"
            class="check-item"
            :title="agent"
          >
            <input
              type="checkbox"
              :checked="form.delegation.enabled_agents.includes(agent)"
              @change="toggleInList(form.delegation.enabled_agents, agent)"
            />
            <span class="check-item__text">{{ displayMap[agent] || agent }}</span>
          </label>
        </div>
        <p v-else class="form-empty">当前 Team 没有可委派的其他 Agent。</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Switch } from '../ui/switch';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import TierFields from './TierFields.vue';
import { createEmptyLLM } from './agentFormModel.js';

defineProps({
  form: { type: Object, required: true },
  agentName: { type: String, default: '' },
  tools: { type: Array, default: () => [] },
  peerAgents: { type: Array, default: () => [] },
  displayMap: { type: Object, default: () => ({}) },
  providerOptions: { type: Array, default: () => [] },
  getTierProviderKey: { type: Function, required: true },
  getTierModelOptions: { type: Function, required: true },
  handleTierProviderChange: { type: Function, required: true },
});

function toggleInList(list, name) {
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
}
</script>

<style scoped>
.agent-form { display: flex; flex-direction: column; gap: var(--spacing-lg); }
/* 压掉全局 form-section 的 padding/margin/border 叠加，用统一 gap 控距 */
.agent-form :deep(.form-section) { gap: var(--spacing-sm); padding: 0; }
.agent-form :deep(.form-section + .form-section) { margin-top: 0; border-top: none; }
.agent-form :deep(.section-head) { padding-bottom: var(--spacing-sm); margin-bottom: 0; border-bottom: 1px solid var(--color-border); }
.agent-form :deep(.section-head h2) { font-size: var(--font-size-md); }
.agent-form :deep([data-slot='field-group']) { gap: var(--spacing-md); }
.agent-form :deep(.section-body) { gap: var(--spacing-md); }
.switch-list { display: flex; flex-direction: column; gap: 2px; }
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 4px 0;
}
.switch-row__copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.switch-row__label { font-size: var(--font-size-sm); color: var(--color-text-primary); font-weight: 500; }
.switch-row__hint { font-size: var(--font-size-xs); color: var(--color-text-muted); line-height: 1.45; }
.system-prompt-input { min-height: 180px; resize: vertical; font-family: var(--font-mono); font-size: var(--font-size-sm); line-height: 1.6; }
.form-empty { color: var(--color-text-muted); font-size: var(--font-size-sm); margin: 0; }
</style>
