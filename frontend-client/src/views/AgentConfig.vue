<template>
  <PageLayout
    title="Agent 配置"
    subtitle="统一管理智能体基础参数、模型、工具与 Skills"
    mobile-title="Agent 配置"
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    max-width="1200px"
    content-padding="var(--spacing-xl)"
    mobile-content-padding="var(--spacing-md)"
  >
    <template #header-actions>
      <CustomSelect
        id="agent-select"
        :model-value="selectedAgent"
        :options="agents.map(a => ({ value: a, label: a }))"
        placeholder="请选择 Agent"
        style="width: 200px"
        @update:model-value="selectedAgent = $event; handleAgentChange()"
      />
      <UiIconButton label="新建 Agent" :disabled="saving || agentLoading" @click="openCreateDialog">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </UiIconButton>
      <UiButton v-if="selectedAgent" variant="primary" :disabled="saving || agentLoading" @click="handleSave" :title="saving ? '保存中' : '保存配置'">
        <template #icon>
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </template>
        <span>{{ saving ? '保存中...' : '保存配置' }}</span>
      </UiButton>
    </template>

    <template #header-menu="{ close }">
      <button class="pl-menu-item" :disabled="saving || agentLoading" @click="openCreateDialog(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        新建 Agent
      </button>
      <button v-if="selectedAgent" class="pl-menu-item" :disabled="agentLoading" @click="handleExport(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        导出配置
      </button>
      <div v-if="selectedAgent" class="pl-menu-divider"></div>
      <button v-if="selectedAgent" class="pl-menu-item pl-menu-item--danger" :disabled="saving || agentLoading" @click="openDeleteDialog(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6"></path>
          <path d="M14 11v6"></path>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
        </svg>
        删除 Agent
      </button>
    </template>

    <template #mobile-menu="{ close }">
      <div class="pl-menu-label">切换 Agent</div>
      <button
        v-for="a in agents"
        :key="a"
        class="pl-menu-item"
        :class="{ 'pl-menu-item--active': a === selectedAgent }"
        @click="selectedAgent = a; handleAgentChange(); close()"
      >
        <svg v-if="a === selectedAgent" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>{{ a }}</span>
      </button>
      <div class="pl-menu-divider"></div>
      <button class="pl-menu-item" :disabled="saving || agentLoading" @click="openCreateDialog(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        新建 Agent
      </button>
      <button v-if="selectedAgent" class="pl-menu-item" :disabled="saving || agentLoading" @click="handleSave(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
          <polyline points="17 21 17 13 7 13 7 21"></polyline>
          <polyline points="7 3 7 8 15 8"></polyline>
        </svg>
        {{ saving ? '保存中...' : '保存配置' }}
      </button>
      <button v-if="selectedAgent" class="pl-menu-item" :disabled="agentLoading" @click="handleExport(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        导出配置
      </button>
      <div v-if="selectedAgent" class="pl-menu-divider"></div>
      <button v-if="selectedAgent" class="pl-menu-item pl-menu-item--danger" :disabled="saving || agentLoading" @click="openDeleteDialog(); close()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
          <path d="M10 11v6"></path>
          <path d="M14 11v6"></path>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
        </svg>
        删除 Agent
      </button>
    </template>

    <div class="agent-config-page" :class="{ 'agent-config-page--embedded': embedded }">
      <div class="team-banner" v-if="activeTeam">
        当前 Team：<strong>{{ activeTeam }}</strong>
      </div>
      <div ref="configBodyRef" class="config-body">
      <EntityListLayout
        v-if="loading || error"
        title="Agent 配置数据"
        description="加载 Agent 列表、模型 Provider、工具、Skills 与 MCP 服务。"
        :loading="loading"
        loading-text="加载中..."
        :error="error"
        @retry="loadInitialData"
      />

      <template v-else>
        <EntityListLayout
          v-if="!selectedAgent"
          title="Agent 配置"
          description="当前 Team 下还没有可配置的 Agent。"
          empty
          empty-title="暂无可配置的 Agent"
          empty-hint="新建 Agent 后即可在这里维护模型、工具、Skills 和委派关系。"
          :retryable="false"
        />

        <template v-else>
          <form class="config-form" @submit.prevent="handleSave">
          <section id="section-basic" class="form-section">
            <div class="section-head">
              <h2>基础信息</h2>
              <span>Agent 基本展示与启用状态</span>
            </div>
            <div class="section-body form-grid">
              <label class="form-item">
                <span class="field-label-text">显示名称</span>
                <input v-model="configForm.display_name" type="text" class="form-control" />
              </label>

              <label class="form-item">
                <span class="field-label-text">描述</span>
                <input v-model="configForm.description" type="text" class="form-control" />
              </label>

              <label class="form-item switch-item">
                <span class="field-label-text">启用该 Agent</span>
                <span class="switch-control">
                  <input v-model="configForm.enabled" type="checkbox" />
                  <span class="switch-control__track"><span class="switch-control__thumb"></span></span>
                </span>
              </label>

              <label class="form-item switch-item">
                <span class="field-label-text">设为默认入口 Agent</span>
                <span class="switch-control">
                  <input v-model="configForm.default_entry" type="checkbox" />
                  <span class="switch-control__track"><span class="switch-control__thumb"></span></span>
                </span>
              </label>
            </div>
          </section>

          <section id="section-llm" class="form-section">
            <div class="section-head">
              <div class="section-head__row">
                <div>
                  <h2>LLM 分层配置</h2>
                  <span>default 为必配主模型，fast/powerful 为可选层级</span>
                </div>
                <button type="button" class="section-head__toggle" @click="tiersCollapsed = !tiersCollapsed">
                  {{ tiersCollapsed ? '展开配置' : '收起配置' }}
                </button>
              </div>
            </div>
            <Transition name="tier-expand">
              <div v-if="!tiersCollapsed" class="section-body">
                <!-- default tier: 始终展示，不可关闭 -->
                <div class="tier-block">
                  <div class="tier-block__head">
                    <div class="tier-toggle active" style="cursor: default;">
                      <span class="tier-toggle__copy">
                        <span class="tier-toggle__name">default</span>
                        <span class="tier-toggle__desc">主 ReAct 推理默认层（必配）</span>
                      </span>
                      <span class="tier-toggle__indicator active">
                        <span class="tier-toggle__indicator-icon">
                          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                            viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                          </svg>
                        </span>
                      </span>
                    </div>
                  </div>
                  <div class="tier-block__body">
                    <div class="form-grid">
                      <label class="form-item">
                        <span class="field-label-text">Provider</span>
                        <CustomSelect
                          :model-value="getTierProviderKey('default')"
                          :options="[{ value: '', label: '未设置' }, ...providers.map(p => ({ value: p.key || p.name, label: p.name + (p.provider_type ? ` (${p.provider_type})` : '') }))]"
                          placeholder="选择 Provider"
                          @update:model-value="handleTierProviderChange('default', $event)"
                        />
                      </label>
                      <label class="form-item">
                        <span class="field-label-text">Provider Type</span>
                        <input :value="configForm.llm_tiers.default?.provider_type || '未设置'" type="text" class="form-control" disabled />
                      </label>
                      <label class="form-item">
                        <span class="field-label-text">Model Name</span>
                        <CustomSelect
                          :model-value="configForm.llm_tiers.default?.model_name"
                          :options="[{ value: '', label: '选择模型' }, ...getTierModelOptions('default').map(m => ({ value: m, label: m }))]"
                          placeholder="选择模型"
                          @update:model-value="configForm.llm_tiers.default.model_name = $event"
                        />
                      </label>
                      <label class="form-item">
                        <span class="field-label-text">Temperature</span>
                        <NumberInput :model-value="configForm.llm_tiers.default?.temperature" :min="0" :max="2" :step="0.1" @update:model-value="configForm.llm_tiers.default.temperature = $event" />
                      </label>
                      <label class="form-item">
                        <span class="field-label-text">Max Completion Tokens</span>
                        <NumberInput :model-value="configForm.llm_tiers.default?.max_completion_tokens" :min="1" :step="1" @update:model-value="configForm.llm_tiers.default.max_completion_tokens = $event" />
                      </label>
                      <label class="form-item">
                        <span class="field-label-text">Max Context Tokens</span>
                        <NumberInput :model-value="configForm.llm_tiers.default?.max_context_tokens" :min="1" :step="1" @update:model-value="configForm.llm_tiers.default.max_context_tokens = $event" />
                      </label>
                    </div>
                    <div class="extra-param-editor">
                      <div class="field-label-row">
                        <span class="field-label-text">额外参数</span>
                        <UiButton size="compact" @click="addExtraParam(configForm.llm_tiers.default)">新增参数</UiButton>
                      </div>
                      <div v-if="configForm.llm_tiers.default?.extra_params_entries?.length" class="extra-param-list">
                        <div v-for="(entry, index) in configForm.llm_tiers.default.extra_params_entries" :key="`default-${index}`" class="extra-param-row">
                          <input v-model.trim="entry.key" type="text" class="form-control" placeholder="key" />
                          <CustomSelect :model-value="entry.type" :options="extraParamTypeOptions" placeholder="type" @update:model-value="entry.type = $event" />
                          <input v-model="entry.value" type="text" class="form-control" placeholder="value" />
                          <UiButton size="compact" variant="danger" class="extra-param-delete-button" @click="removeExtraParam(configForm.llm_tiers.default, index)">删除</UiButton>
                        </div>
                      </div>
                      <div v-else class="state-panel state-panel--empty state-panel--compact adm-state adm-state--empty">
                        <p>暂无额外参数</p>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- fast / powerful: 可 toggle -->
                <div v-for="tier in ['fast', 'powerful']" :key="tier" class="tier-block">
                  <div class="tier-block__head">
                    <button
                      type="button"
                      class="tier-toggle"
                      :class="{ active: !!configForm.llm_tiers[tier] }"
                      @click="configForm.llm_tiers[tier] = configForm.llm_tiers[tier] ? null : createEmptyLLM()"
                    >
                      <span class="tier-toggle__copy">
                        <span class="tier-toggle__name">{{ tier }}</span>
                        <span class="tier-toggle__desc">{{ tier === 'default' ? '主 ReAct 推理默认层' : tier === 'fast' ? '简单任务（压缩、格式化等），成本优化' : '复杂推理任务（可选）' }}</span>
                      </span>
                      <span class="tier-toggle__indicator" :class="{ active: !!configForm.llm_tiers[tier] }">
                        <span class="tier-toggle__indicator-icon">
                          <svg
                            xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                            viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"></polyline>
                          </svg>
                        </span>
                      </span>
                    </button>
                  </div>
                  <Transition name="tier-expand">
                    <div v-if="configForm.llm_tiers[tier]" class="tier-block__body">
                      <div class="form-grid">
                        <label class="form-item">
                          <span class="field-label-text">Provider</span>
                          <CustomSelect
                            :model-value="getTierProviderKey(tier)"
                            :options="[{ value: '', label: '未设置' }, ...providers.map(p => ({ value: p.key || p.name, label: p.name + (p.provider_type ? ` (${p.provider_type})` : '') }))]"
                            placeholder="未设置"
                            @update:model-value="handleTierProviderChange(tier, $event)"
                          />
                        </label>
                        <label class="form-item">
                          <span class="field-label-text">Provider Type</span>
                          <input :value="configForm.llm_tiers[tier].provider_type || '未设置'" type="text" class="form-control" disabled />
                        </label>
                        <label class="form-item">
                          <span class="field-label-text">Model Name</span>
                          <CustomSelect
                            :model-value="configForm.llm_tiers[tier].model_name"
                            :options="[{ value: '', label: '选择模型' }, ...getTierModelOptions(tier).map(m => ({ value: m, label: m }))]"
                            placeholder="选择模型"
                            @update:model-value="configForm.llm_tiers[tier].model_name = $event"
                          />
                        </label>
                        <label class="form-item">
                          <span class="field-label-text">Temperature</span>
                          <NumberInput :model-value="configForm.llm_tiers[tier].temperature" :min="0" :max="2" :step="0.1" @update:model-value="configForm.llm_tiers[tier].temperature = $event" />
                        </label>
                        <label class="form-item">
                          <span class="field-label-text">Max Completion Tokens</span>
                          <NumberInput :model-value="configForm.llm_tiers[tier].max_completion_tokens" :min="1" :step="1" @update:model-value="configForm.llm_tiers[tier].max_completion_tokens = $event" />
                        </label>
                        <label class="form-item">
                          <span class="field-label-text">Max Context Tokens</span>
                          <NumberInput :model-value="configForm.llm_tiers[tier].max_context_tokens" :min="1" :step="1" @update:model-value="configForm.llm_tiers[tier].max_context_tokens = $event" />
                        </label>
                      </div>

                      <div class="extra-param-editor">
                        <div class="field-label-row">
                          <span class="field-label-text">额外参数</span>
                          <UiButton size="compact" @click="addExtraParam(configForm.llm_tiers[tier])">新增参数</UiButton>
                        </div>
                        <div v-if="configForm.llm_tiers[tier].extra_params_entries.length" class="extra-param-list">
                          <div v-for="(entry, index) in configForm.llm_tiers[tier].extra_params_entries" :key="`${tier}-${index}`" class="extra-param-row">
                            <input v-model.trim="entry.key" type="text" class="form-control" placeholder="key" />
                            <CustomSelect
                              :model-value="entry.type"
                              :options="extraParamTypeOptions"
                              placeholder="type"
                              @update:model-value="entry.type = $event"
                            />
                            <input v-model="entry.value" type="text" class="form-control" placeholder="value" />
                            <UiButton size="compact" variant="danger" class="extra-param-delete-button" @click="removeExtraParam(configForm.llm_tiers[tier], index)">删除</UiButton>
                          </div>
                        </div>
                        <div v-else class="state-panel state-panel--empty state-panel--compact adm-state adm-state--empty">
                          <p>暂无额外参数</p>
                        </div>
                        <small class="field-hint">type 可选 string / number / boolean / json，json 类型的 value 需填写合法 JSON</small>
                      </div>
                    </div>
                  </Transition>
                </div>
              </div>
            </Transition>
          </section>

          <section id="section-prompt" class="form-section">
            <div class="section-head">
              <h2>系统提示词</h2>
              <span>编辑当前 Agent 的 custom_params.behavior.system_prompt</span>
            </div>
            <div class="section-body">
              <label class="form-item">
                <span class="field-label-text">系统提示词</span>
                <textarea
                  ref="systemPromptTextareaRef"
                  v-model="configForm.custom_params.behavior.system_prompt"
                  class="form-control form-control--textarea"
                  rows="8"
                  placeholder="请输入该 Agent 的 system prompt"
                  @input="autoResizeSystemPrompt"
                ></textarea>
              </label>
            </div>
          </section>

          <section id="section-tools" class="form-section">
            <div class="section-head">
              <h2>工具</h2>
              <span>选择当前 Agent 可使用的工具能力</span>
            </div>
            <div class="section-body toggle-grid">
              <div
                v-for="tool in tools"
                :key="tool.name"
                class="toggle-card"
                :class="{ active: configForm.tools.enabled_tools.includes(tool.name) }"
                @click="toggleTool(tool.name, !configForm.tools.enabled_tools.includes(tool.name))"
              >
                <div class="toggle-card__indicator">
                  <svg v-if="configForm.tools.enabled_tools.includes(tool.name)"
                    xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div class="toggle-card__name">{{ tool.display_name || tool.name }}</div>
                <div class="toggle-card__desc">{{ tool.description || tool.name }}</div>
              </div>
            </div>
          </section>

          <section id="section-tasks" class="form-section">
            <div class="section-head">
              <h2>任务</h2>
              <span>配置 task capability；task 工具不再通过普通工具白名单单独勾选</span>
            </div>
            <div class="section-body toggle-grid">
              <div
                class="toggle-card"
                :class="{ active: configForm.tasks.workflow }"
                @click="configForm.tasks.workflow = !configForm.tasks.workflow"
              >
                <div class="toggle-card__indicator">
                  <svg v-if="configForm.tasks.workflow"
                    xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div class="toggle-card__name">workflow</div>
                <div class="toggle-card__desc">暴露 task_create / task_get / task_update / task_list，用于任务编排与状态追踪</div>
              </div>

              <div
                class="toggle-card"
                :class="{ active: configForm.tasks.background }"
                @click="configForm.tasks.background = !configForm.tasks.background"
              >
                <div class="toggle-card__indicator">
                  <svg v-if="configForm.tasks.background"
                    xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
                <div class="toggle-card__name">background</div>
                <div class="toggle-card__desc">暴露 task_output / task_stop，用于后台任务查询、显式等待与停止</div>
              </div>
            </div>
          </section>

          <section id="section-skills" class="form-section">
            <div class="section-head">
              <h2>技能</h2>
              <span>管理领域知识与脚本能力注入</span>
            </div>
            <div class="section-body skills-body">
              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.skills.auto_inject" type="checkbox" />
                <span>自动注入内置/工作区技能</span>
              </label>

              <div v-for="group in skillGroups" :key="group.key" class="skill-group">
                <div class="subsection-title">{{ group.title }}</div>
                <div v-if="group.hint" class="skill-group__hint">{{ group.hint }}</div>
                <div class="toggle-grid">
                  <div
                    v-for="skill in group.items"
                    :key="`${group.key}-${skill.name}`"
                    class="toggle-card"
                    :class="{ active: configForm.skills.enabled_skills.includes(skill.name) }"
                    @click="toggleSkill(skill.name, !configForm.skills.enabled_skills.includes(skill.name))"
                  >
                    <div class="toggle-card__indicator">
                      <svg v-if="configForm.skills.enabled_skills.includes(skill.name)"
                        xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                    <div class="toggle-card__name">{{ skill.display_name || skill.name }}</div>
                    <div class="toggle-card__desc">{{ skill.description || skill.name }}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section id="section-memory" class="form-section">
            <div class="section-head">
              <h2>记忆</h2>
              <span>按 Agent 配置记忆索引注入与 scope 权限；memory 工具的 team/session/agent/workspace 定位信息由运行时自动推导</span>
            </div>
            <div class="section-body skills-body">
              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.memory.auto_inject" type="checkbox" />
                <span>自动注入记忆索引</span>
              </label>

              <div class="subsection-title">Scope 权限</div>
              <div class="toggle-grid">
                <div
                  v-for="scope in memoryScopeMeta"
                  :key="scope.name"
                  class="toggle-card memory-scope-card"
                >
                  <div class="memory-scope-card__header">
                    <div class="toggle-card__name">{{ scope.name }}</div>
                    <div class="toggle-card__desc">{{ scope.description }}</div>
                  </div>
                  <div class="memory-scope-card__permissions">
                    <label class="memory-scope-card__permission">
                      <input
                        :checked="configForm.memory.allowed_scopes.includes(scope.name)"
                        type="checkbox"
                        @click.stop
                        @change="toggleMemoryScope('allowed_scopes', scope.name, $event.target.checked)"
                      />
                      <span>读取</span>
                    </label>
                    <label class="memory-scope-card__permission">
                      <input
                        :checked="configForm.memory.write_scopes.includes(scope.name)"
                        type="checkbox"
                        @click.stop
                        @change="toggleMemoryScope('write_scopes', scope.name, $event.target.checked)"
                      />
                      <span>写入</span>
                    </label>
                    <label class="memory-scope-card__permission">
                      <input
                        :checked="configForm.memory.archive_scopes.includes(scope.name)"
                        type="checkbox"
                        @click.stop
                        @change="toggleMemoryScope('archive_scopes', scope.name, $event.target.checked)"
                      />
                      <span>归档</span>
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section id="section-mcp" class="form-section">
            <div class="section-head">
              <h2>MCP 服务</h2>
              <span>将可用 MCP Server 授权给当前 Agent</span>
            </div>
            <div class="section-body">
              <div v-if="mcpServers.length === 0" class="state-panel state-panel--empty state-panel--compact adm-state adm-state--empty">
                <p>当前还没有可用的 MCP 服务，请先在管理端完成 MCP Server 配置。</p>
              </div>

              <div v-else class="toggle-grid">
                <div
                  v-for="server in mcpServers"
                  :key="server.name"
                  class="toggle-card"
                  :class="{ active: configForm.mcp.enabled_servers.includes(server.name) }"
                  @click="toggleMcpServer(server.name, !configForm.mcp.enabled_servers.includes(server.name))"
                >
                  <div class="toggle-card__indicator">
                    <svg v-if="configForm.mcp.enabled_servers.includes(server.name)"
                      xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <div class="toggle-card__name">{{ server.display_name || server.name }}</div>
                  <div class="toggle-card__desc">{{ server.transport || 'stdio' }} · {{ server.status || 'unknown' }} · {{ server.tool_count || 0 }} tools</div>
                  <div class="toggle-card__meta toggle-card__meta--badges">
                    <span class="toggle-card__badge">{{ server.enabled ? '已启用' : '已禁用' }}</span>
                    <span v-if="server.error_message" class="toggle-card__badge toggle-card__badge--danger">{{ server.error_message }}</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section id="section-delegation" class="form-section">
            <div class="section-head">
              <h2>委派</h2>
              <span>控制当前 Agent 可委派的其他 Agent</span>
            </div>
            <div class="section-body">
              <div class="toggle-grid">
                <div
                  v-for="agent in agents.filter(a => a !== selectedAgent)"
                  :key="agent"
                  class="toggle-card"
                  :class="{ active: configForm.delegation.enabled_agents.includes(agent) }"
                  @click="toggleDelegation(agent, !configForm.delegation.enabled_agents.includes(agent))"
                >
                  <div class="toggle-card__indicator">
                    <svg v-if="configForm.delegation.enabled_agents.includes(agent)" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <div class="toggle-card__name">{{ agent }}</div>
                </div>
              </div>
            </div>
          </section>

        </form>

        </template>
      </template>

    <Teleport to="body">
      <nav v-if="selectedAgent && !loading && !error" class="section-nav section-nav--desktop">
        <a v-for="s in sections" :key="s.id" :class="{ active: activeSection === s.id }" :title="s.label" @click="scrollToSection(s.id)">
          <span class="section-nav__dot"></span>
          <span class="section-nav__label">{{ s.label }}</span>
        </a>
      </nav>
    </Teleport>
    </div>

    <Teleport to="body">
      <button class="btn-scroll-bottom" title="滚动到底部" @click="scrollToBottom">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </Teleport>

    <Teleport to="body">
      <nav v-if="selectedAgent && !loading && !error" class="section-nav section-nav--mobile">
        <a v-for="s in sections" :key="s.id" :class="{ active: activeSection === s.id }" @click="scrollToSection(s.id)">
          <span class="section-nav__label-inner">{{ s.label }}</span>
        </a>
      </nav>
    </Teleport>

    <AppToast ref="toastRef" />

    <!-- 新建 Agent 对话框 -->
    <Teleport to="body">
      <div v-if="createDialog.visible" class="modal-overlay">
        <div ref="createDialogPanelRef" class="modal-panel adm-modal">
          <div class="modal-head adm-modal-header">
            <h3>新建 Agent</h3>
            <button class="modal-close" @click="closeCreateDialog">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="modal-body adm-modal-body">
            <label class="form-item adm-field">
              <span class="field-label-text adm-field-label">Agent 名称 <em class="required-mark">*</em></span>
              <input
                v-model.trim="createDialog.agentName"
                type="text"
                class="form-control adm-form-control"
                placeholder="仅限英文、数字和下划线，如 my_agent"
                @keydown.enter="handleCreateAgent"
              />
              <small class="field-hint adm-form-hint">创建后不可修改，将作为唯一标识符</small>
            </label>
            <label class="form-item adm-field">
              <span class="field-label-text adm-field-label">显示名称</span>
              <input v-model.trim="createDialog.displayName" type="text" class="form-control adm-form-control" placeholder="可选，留空则使用 Agent 名称" @keydown.enter="handleCreateAgent" />
            </label>
            <label class="form-item adm-field">
              <span class="field-label-text adm-field-label">描述</span>
              <input v-model.trim="createDialog.description" type="text" class="form-control adm-form-control" placeholder="可选" @keydown.enter="handleCreateAgent" />
            </label>
          </div>
          <div class="modal-foot adm-modal-footer">
            <UiButton size="compact" :disabled="createDialog.loading" @click="closeCreateDialog">取消</UiButton>
            <UiButton size="compact" variant="primary" :disabled="createDialog.loading || !createDialog.agentName" @click="handleCreateAgent">
              {{ createDialog.loading ? '创建中...' : '创建' }}
            </UiButton>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除 Agent 确认对话框 -->
    <Teleport to="body">
      <div v-if="deleteDialog.visible" class="modal-overlay">
        <div ref="deleteDialogPanelRef" class="modal-panel modal-panel--sm adm-modal">
          <div class="modal-head adm-modal-header">
            <h3>删除 Agent</h3>
            <button class="modal-close" @click="closeDeleteDialog">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="modal-body adm-modal-body">
            <p class="delete-confirm-text">确定要删除 Agent <strong>{{ deleteDialog.agentName }}</strong> 吗？此操作不可撤销。</p>
          </div>
          <div class="modal-foot adm-modal-footer">
            <UiButton size="compact" :disabled="deleteDialog.loading" @click="closeDeleteDialog">取消</UiButton>
            <UiButton size="compact" variant="danger" :disabled="deleteDialog.loading" @click="handleDeleteAgent">
              {{ deleteDialog.loading ? '删除中...' : '确认删除' }}
            </UiButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</PageLayout>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick, watch, computed } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import {
  getAllAgentConfigs,
  getAgentConfig,
  updateAgentConfig,
  createAgent,
  deleteAgent,
  getAvailableTools,
  getAvailableSkills,
  getAvailableMCPServers,
  getMemoryConfigMetadata,
  getTeams
} from '../api/agentConfig';
import { getProviders } from '../api/modelAdapter';
import CustomSelect from '../components/CustomSelect.vue';
import NumberInput from '../components/NumberInput.vue';
import AppToast from '../components/AppToast.vue';
import { UiButton, UiIconButton } from '../components/ui';
import { usePointerDownOutside } from '../composables/usePointerDownOutside';
const props = defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const sections = [
  { id: 'section-basic', label: '基础' },
  { id: 'section-llm', label: 'LLM' },
  { id: 'section-prompt', label: '提示词' },
  { id: 'section-tools', label: '工具' },
  { id: 'section-tasks', label: '任务' },
  { id: 'section-skills', label: '技能' },
  { id: 'section-memory', label: '记忆' },
  { id: 'section-mcp', label: 'MCP' },
  { id: 'section-delegation', label: '委派' }
];
const activeSection = ref('section-basic');
const tiersCollapsed = ref(false);
let observer = null;
let scrollContainerEl = null;
let isClickScrolling = false;
let scrollTimeout = null;
let observeTimer = null;

// 更新滑块位置
function updateSliderPosition() {
  // 更新移动端（滑块宽度与文本内容实际大小关联）
  const mobileNav = document.querySelector('.section-nav--mobile');
  if (mobileNav) {
    const activeIndex = sections.findIndex(s => s.id === activeSection.value);
    if (activeIndex !== -1) {
      const tabs = mobileNav.querySelectorAll('a');
      const activeTab = tabs[activeIndex];
      if (activeTab) {
        const tabRect = activeTab.getBoundingClientRect();
        const labelEl = activeTab.querySelector('.section-nav__label-inner');
        const contentWidth = labelEl ? labelEl.getBoundingClientRect().width : tabRect.width;
        const padding = 24; // 左右各 12px padding
        const left = activeTab.offsetLeft + (tabRect.width - contentWidth) / 2 - padding / 2;
        mobileNav.style.setProperty('--slider-left', `${left}px`);
        mobileNav.style.setProperty('--slider-width', `${contentWidth + padding}px`);
      }
    }
  }

  // 更新桌面端
  const desktopNav = document.querySelector('.section-nav--desktop');
  if (desktopNav) {
    const activeIndex = sections.findIndex(s => s.id === activeSection.value);
    if (activeIndex !== -1) {
      const tabs = desktopNav.querySelectorAll('a');
      const activeTab = tabs[activeIndex];
      if (activeTab) {
        const top = activeTab.offsetTop;
        const height = activeTab.getBoundingClientRect().height;
        desktopNav.style.setProperty('--slider-top', `${top}px`);
        desktopNav.style.setProperty('--slider-height', `${height}px`);
      }
    }
  }
}

function scrollToSection(id) {
  isClickScrolling = true;
  activeSection.value = id;
  updateSliderPosition();

  if (scrollTimeout) clearTimeout(scrollTimeout);

  const element = document.getElementById(id);
  const container = getScrollContainer();
  if (element && container) {
    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const top = container.scrollTop + elementRect.top - containerRect.top - 16;
    container.scrollTo({ top, behavior: 'smooth' });
    scrollTimeout = setTimeout(() => {
      isClickScrolling = false;
    }, 600);
  }
}

const configBodyRef = ref(null);
const systemPromptTextareaRef = ref(null);

function getScrollContainer() {
  return (
    configBodyRef.value?.closest('.page-content-scroll') ||
    configBodyRef.value?.closest('.page-content') ||
    configBodyRef.value
  );
}

function getSystemPromptTextareaMaxHeight() {
  return Math.min(520, Math.max(260, Math.floor(window.innerHeight * 0.42)));
}

function updateActiveSectionByScroll() {
  if (isClickScrolling) return;

  const container = getScrollContainer();
  if (!container) return;

  const containerRect = container.getBoundingClientRect();
  const anchorY = containerRect.top + Math.min(120, Math.max(48, containerRect.height * 0.2));

  let currentSection = sections[0]?.id || 'section-basic';

  for (const section of sections) {
    const el = document.getElementById(section.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.top <= anchorY) {
      currentSection = section.id;
    } else {
      break;
    }
  }

  if (currentSection !== activeSection.value) {
    activeSection.value = currentSection;
    updateSliderPosition();
  }
}

function bindScrollTracking() {
  const nextContainer = getScrollContainer();

  if (scrollContainerEl && scrollContainerEl !== nextContainer) {
    scrollContainerEl.removeEventListener('scroll', updateActiveSectionByScroll);
  }

  scrollContainerEl = nextContainer;
  scrollContainerEl?.removeEventListener('scroll', updateActiveSectionByScroll);
  scrollContainerEl?.addEventListener('scroll', updateActiveSectionByScroll, { passive: true });
}

function resetSectionObserver() {
  observer?.disconnect();
  observer = null;

  if (observeTimer) {
    clearTimeout(observeTimer);
    observeTimer = null;
  }

  if (!selectedAgent.value || loading.value || error.value) {
    return;
  }

  bindScrollTracking();

  observeTimer = setTimeout(() => {
    updateActiveSectionByScroll();
    updateSliderPosition();
    observeTimer = null;
  }, 0);
}

function scrollToBottom() {
  const el = getScrollContainer();
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function autoResizeSystemPrompt() {
  const textarea = systemPromptTextareaRef.value;
  if (!textarea) return;
  textarea.style.height = 'auto';
  const maxHeight = getSystemPromptTextareaMaxHeight();
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
  textarea.style.height = `${nextHeight}px`;
  textarea.style.maxHeight = `${maxHeight}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

const loading = ref(false);
const saving = ref(false);
const agentLoading = ref(false);
const error = ref('');
const toastRef = ref(null);

function showToast(message, type = 'error') {
  toastRef.value?.show(message, type);
}

const agents = ref([]);
const agentDisplayMap = ref({});
const activeTeam = ref('');
const selectedAgent = ref('');
const tools = ref([]);
const skills = ref([]);
const skillGroups = computed(() => ([
  {
    key: 'workspace',
    title: '工作区技能',
    hint: '入口 Agent 默认可见；其他 Agent 需显式勾选。',
    items: skills.value.filter(skill => skill.source_type === 'workspace')
  },
  {
    key: 'user_global',
    title: '全局技能',
    hint: '仅在当前 Agent 显式勾选后生效。',
    items: skills.value.filter(skill => skill.source_type === 'user_global')
  },
  {
    key: 'builtin',
    title: '内置技能',
    hint: '',
    items: skills.value.filter(skill => skill.source_type !== 'workspace' && skill.source_type !== 'user_global')
  }
]).filter(group => group.items.length > 0));
const mcpServers = ref([]);
const providers = ref([]);
const memoryScopeMeta = ref([]);

const configForm = ref(createEmptyForm());
const rawConfig = ref(createEmptyForm());

function normalizeModelList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  const model = String(value || '').trim();
  return model ? [model] : [];
}

function getProviderModels(provider) {
  if (!provider) return [];

  const models = [];
  const seen = new Set();
  const addModels = value => {
    for (const model of normalizeModelList(value)) {
      if (!seen.has(model)) {
        models.push(model);
        seen.add(model);
      }
    }
  };

  if (provider.model_map && typeof provider.model_map === 'object') {
    addModels(provider.model_map.chat);
    Object.entries(provider.model_map).forEach(([task, value]) => {
      if (task !== 'chat') addModels(value);
    });
  }
  addModels(provider.models);
  addModels(provider.model);
  return models;
}

const memoryScopeFallbackMeta = [
  { name: 'team', description: '团队级长期记忆，适合跨会话复用的共享偏好、约束与背景事实。' },
  { name: 'session', description: '当前会话记忆，适合记录本轮协作中形成的稳定偏好和上下文。' },
  { name: 'agent', description: '当前 team 内 Agent 私有记忆，仅适合该 Agent 在所属 team 中独立维护的长期信息。' },
  { name: 'workspace', description: '当前工作区记忆，优先绑定显式 workspace_root；若 session 未提供该字段，则自动回退到默认 session workspace，并基于完整路径生成稳定 workspace key。' }
];

const extraParamTypeOptions = [
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'boolean', label: 'boolean' },
  { value: 'json', label: 'json' }
];

function createEmptyLLM() {
  return {
    provider: '',
    provider_type: '',
    model_name: '',
    temperature: 0.7,
    max_completion_tokens: 4096,
    max_context_tokens: 128000,
    extra_params_entries: []
  };
}

function createExtraParamEntry(key = '', type = 'string', value = '') {
  return { key, type, value };
}

function parseExtraParamEntries(extraParams) {
  if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) {
    return [];
  }
  return Object.entries(extraParams).map(([key, value]) => {
    if (typeof value === 'number') {
      return createExtraParamEntry(key, 'number', String(value));
    }
    if (typeof value === 'boolean') {
      return createExtraParamEntry(key, 'boolean', value ? 'true' : 'false');
    }
    if (value && typeof value === 'object') {
      try {
        return createExtraParamEntry(key, 'json', JSON.stringify(value));
      } catch {
        return createExtraParamEntry(key, 'json', '{}');
      }
    }
    return createExtraParamEntry(key, 'string', value == null ? '' : String(value));
  });
}

function createEmptyForm() {
  return {
    agent_name: '',
    display_name: '',
    description: '',
    enabled: true,
    default_entry: false,
    llm_tiers: { default: createEmptyLLM(), fast: null, powerful: null },
    tools: { enabled_tools: [] },
    tasks: { workflow: false, background: false },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ['team', 'session'],
      write_scopes: ['session'],
      archive_scopes: ['session']
    },
    delegation: { enabled_agents: [] },
    custom_params: { behavior: { system_prompt: '' } }
  };
}

function parseTierLLM(tier) {
  if (!tier) return null;
  return {
    provider: tier.provider || '',
    provider_type: tier.provider_type || '',
    model_name: tier.model_name || '',
    temperature: tier.temperature ?? 0.7,
    max_completion_tokens: tier.max_completion_tokens ?? 4096,
    max_context_tokens: tier.max_context_tokens ?? 128000,
    extra_params_entries: parseExtraParamEntries(tier.extra_params)
  };
}

function applyConfigToForm(config) {
  const safeConfig = config || createEmptyForm();
  rawConfig.value = JSON.parse(JSON.stringify(safeConfig));
  configForm.value = {
    agent_name: safeConfig.agent_name || '',
    display_name: safeConfig.display_name || '',
    description: safeConfig.description || '',
    enabled: safeConfig.enabled ?? true,
    default_entry: safeConfig.default_entry ?? safeConfig.custom_params?.default_entry ?? false,
    llm_tiers: {
      default: parseTierLLM(safeConfig.llm_tiers?.default) || createEmptyLLM(),
      fast: parseTierLLM(safeConfig.llm_tiers?.fast),
      powerful: parseTierLLM(safeConfig.llm_tiers?.powerful)
    },
    tools: {
      enabled_tools: Array.isArray(safeConfig.tools?.enabled_tools) ? [...safeConfig.tools.enabled_tools] : []
    },
    tasks: {
      workflow: !!safeConfig.tasks?.workflow,
      background: !!safeConfig.tasks?.background
    },
    skills: {
      enabled_skills: Array.isArray(safeConfig.skills?.enabled_skills) ? [...safeConfig.skills.enabled_skills] : [],
      auto_inject: safeConfig.skills?.auto_inject ?? true
    },
    mcp: {
      enabled_servers: Array.isArray(safeConfig.mcp?.enabled_servers) ? [...safeConfig.mcp.enabled_servers] : []
    },
    memory: {
      auto_inject: safeConfig.memory?.auto_inject ?? true,
      allowed_scopes: Array.isArray(safeConfig.memory?.allowed_scopes) ? [...safeConfig.memory.allowed_scopes] : ['team', 'session'],
      write_scopes: Array.isArray(safeConfig.memory?.write_scopes) ? [...safeConfig.memory.write_scopes] : ['session'],
      archive_scopes: Array.isArray(safeConfig.memory?.archive_scopes) ? [...safeConfig.memory.archive_scopes] : ['session']
    },
    delegation: {
      enabled_agents: Array.isArray(safeConfig.delegation?.enabled_agents) ? [...safeConfig.delegation.enabled_agents] : []
    },
    custom_params: {
      ...(safeConfig.custom_params || {}),
      behavior: {
        ...(safeConfig.custom_params?.behavior || {}),
        system_prompt: safeConfig.custom_params?.behavior?.system_prompt || ''
      }
    }
  };

  nextTick(() => autoResizeSystemPrompt());
}

function addExtraParam(target) {
  if (!target.extra_params_entries) {
    target.extra_params_entries = [];
  }
  target.extra_params_entries.push(createExtraParamEntry());
}

function removeExtraParam(target, index) {
  if (!target?.extra_params_entries) {
    return;
  }
  target.extra_params_entries.splice(index, 1);
}

function parseExtraParamsInput(entries, scopeLabel) {
  const result = {};
  for (const entry of entries || []) {
    const key = (entry?.key || '').trim();
    if (!key) {
      continue;
    }
    const type = entry?.type || 'string';
    const rawValue = entry?.value ?? '';

    if (type === 'string') {
      result[key] = String(rawValue);
      continue;
    }
    if (type === 'number') {
      const parsedNumber = Number(rawValue);
      if (rawValue === '' || Number.isNaN(parsedNumber)) {
        throw new Error(`${scopeLabel}参数 ${key} 的 value 必须是数字`);
      }
      result[key] = parsedNumber;
      continue;
    }
    if (type === 'boolean') {
      const normalized = String(rawValue).trim().toLowerCase();
      if (normalized === 'true') {
        result[key] = true;
        continue;
      }
      if (normalized === 'false') {
        result[key] = false;
        continue;
      }
      throw new Error(`${scopeLabel}参数 ${key} 的 value 必须是 true 或 false`);
    }
    if (type === 'json') {
      try {
        result[key] = JSON.parse(String(rawValue || '{}'));
      } catch {
        throw new Error(`${scopeLabel}参数 ${key} 的 value 必须是合法 JSON`);
      }
      continue;
    }
    throw new Error(`${scopeLabel}参数 ${key} 的 type 无效`);
  }
  return result;
}

function buildPayload() {
  const merged = JSON.parse(JSON.stringify(rawConfig.value || {}));
  merged.agent_name = selectedAgent.value;
  merged.display_name = configForm.value.display_name;
  merged.description = configForm.value.description;
  merged.enabled = configForm.value.enabled;
  merged.default_entry = !!configForm.value.default_entry;

  const mainLLM = configForm.value.llm_tiers.default;
  function buildTier(tier, tierName) {
    if (!tier) return null;
    return {
      provider: tier.provider || null,
      provider_type: tier.provider_type || null,
      model_name: tier.model_name || null,
      temperature: tier.temperature === '' ? null : Number(tier.temperature),
      max_completion_tokens: tier.max_completion_tokens === '' ? null : Number(tier.max_completion_tokens),
      max_context_tokens: tier.max_context_tokens === '' ? null : Number(tier.max_context_tokens),
      extra_params: parseExtraParamsInput(tier.extra_params_entries, `${tierName} 层级`)
    };
  }
  const builtTiers = {};
  builtTiers.default = buildTier(mainLLM, 'default');
  const tiers = configForm.value.llm_tiers;
  if (tiers.fast) builtTiers.fast = buildTier(tiers.fast, 'fast');
  if (tiers.powerful) builtTiers.powerful = buildTier(tiers.powerful, 'powerful');
  merged.llm_tiers = Object.keys(builtTiers).length ? builtTiers : null;

  merged.tools = {
    ...(merged.tools || {}),
    enabled_tools: configForm.value.tools.enabled_tools
  };

  merged.tasks = {
    ...(merged.tasks || {}),
    workflow: !!configForm.value.tasks.workflow,
    background: !!configForm.value.tasks.background
  };

  merged.skills = {
    ...(merged.skills || {}),
    enabled_skills: configForm.value.skills.enabled_skills,
    auto_inject: configForm.value.skills.auto_inject
  };

  merged.mcp = {
    ...(merged.mcp || {}),
    enabled_servers: configForm.value.mcp.enabled_servers
  };

  merged.memory = {
    auto_inject: !!configForm.value.memory.auto_inject,
    allowed_scopes: configForm.value.memory.allowed_scopes,
    write_scopes: configForm.value.memory.write_scopes,
    archive_scopes: configForm.value.memory.archive_scopes
  };

  merged.delegation = {
    ...(merged.delegation || {}),
    enabled_agents: configForm.value.delegation.enabled_agents
  };

  merged.custom_params = configForm.value.custom_params || merged.custom_params || {};
  if (merged.custom_params && Object.prototype.hasOwnProperty.call(merged.custom_params, 'default_entry')) {
    delete merged.custom_params.default_entry;
  }
  return merged;
}

async function loadSupplementaryData(workspaceRoot = '') {
  const [toolResult, skillResult, mcpServerResult, providerResult, memoryResult] = await Promise.allSettled([
    getAvailableTools(),
    getAvailableSkills(workspaceRoot),
    getAvailableMCPServers(),
    getProviders(),
    getMemoryConfigMetadata()
  ]);

  tools.value = toolResult.status === 'fulfilled' && Array.isArray(toolResult.value) ? toolResult.value : [];
  skills.value = skillResult.status === 'fulfilled' && Array.isArray(skillResult.value) ? skillResult.value : [];
  mcpServers.value = mcpServerResult.status === 'fulfilled' && Array.isArray(mcpServerResult.value) ? mcpServerResult.value : [];
  providers.value = providerResult.status === 'fulfilled' && Array.isArray(providerResult.value) ? providerResult.value : [];
  memoryScopeMeta.value = memoryResult.status === 'fulfilled'
    && Array.isArray(memoryResult.value?.scopes)
    && memoryResult.value.scopes.length
    ? memoryResult.value.scopes
    : memoryScopeFallbackMeta;
}

async function loadInitialData() {
  loading.value = true;
  error.value = '';

  try {
    const [configs, teamSummary] = await Promise.all([
      getAllAgentConfigs(),
      getTeams()
    ]);
    const agentNames = Object.keys(configs || {});
    agents.value = agentNames;
    agentDisplayMap.value = Object.fromEntries(
      Object.entries(configs || {}).map(([name, cfg]) => [name, cfg?.display_name || name])
    );
    activeTeam.value = teamSummary?.active_team || '';

    if (agentNames.length > 0) {
      selectedAgent.value = agentNames[0];
      configForm.value = createEmptyForm();
      rawConfig.value = createEmptyForm();
      loading.value = false;
      // loadAgentDetail 内部会调用 loadSupplementaryData(workspace_root)
      loadAgentDetail(agentNames[0]);
    } else {
      selectedAgent.value = '';
      configForm.value = createEmptyForm();
      rawConfig.value = createEmptyForm();
      loading.value = false;
      loadSupplementaryData().catch(err => {
        console.error('加载 Agent 辅助配置失败:', err);
        showToast(err.message || '部分辅助配置加载失败');
      });
    }
  } catch (err) {
    error.value = err.message || '加载 Agent 配置失败';
    loading.value = false;
  }
}

async function loadAgentDetail(agentName) {
  if (!agentName) return;

  agentLoading.value = true;

  try {
    const config = await getAgentConfig(agentName);
    applyConfigToForm(config);
    await loadSupplementaryData(config?.custom_params?.workspace_root || '');
  } catch (err) {
    configForm.value = createEmptyForm();
    rawConfig.value = createEmptyForm();
    showToast(err.message || '加载 Agent 详情失败');
  } finally {
    agentLoading.value = false;
  }
}

async function handleAgentChange() {
  await loadAgentDetail(selectedAgent.value);
}

async function handleSave() {
  if (!selectedAgent.value) return;

  if (!configForm.value.llm_tiers.default?.provider) {
    showToast('请选择默认 LLM 的 Provider');
    return;
  }
  for (const tier of ['default', 'fast', 'powerful']) {
    const t = configForm.value.llm_tiers[tier];
    if (t && !t.provider) {
      showToast(`请选择 ${tier} 层级的 Provider，或禁用该层级`);
      return;
    }
  }

  saving.value = true;

  try {
    await updateAgentConfig(selectedAgent.value, buildPayload());
    const latest = await getAgentConfig(selectedAgent.value);
    applyConfigToForm(latest);
    showToast('保存成功', 'success');
  } catch (err) {
    showToast(err.message || '保存配置失败');
  } finally {
    saving.value = false;
  }
}

function getTierProviderKey(tier) {
  const t = configForm.value.llm_tiers[tier];
  if (!t?.provider) return '';
  const matched = providers.value.find(p => p.name === t.provider && (!t.provider_type || p.provider_type === t.provider_type));
  return matched ? (matched.key || matched.name) : '';
}

function getTierModelOptions(tier) {
  const key = getTierProviderKey(tier);
  if (!key) return [];
  const p = providers.value.find(item => (item?.key || item?.name) === key);
  return getProviderModels(p);
}

function handleTierProviderChange(tier, key) {
  const t = configForm.value.llm_tiers[tier];
  if (!t) return;
  if (!key) { t.provider = ''; t.provider_type = ''; return; }
  const p = providers.value.find(item => (item?.key || item?.name) === key);
  if (!p) return;
  t.provider = p.name || '';
  t.provider_type = p.provider_type || '';
  const models = getProviderModels(p);
  t.model_name = models[0] || '';
  if (p.temperature != null) t.temperature = Number(p.temperature);
  if (p.max_completion_tokens != null) t.max_completion_tokens = Number(p.max_completion_tokens);
  if (p.max_context_tokens != null) t.max_context_tokens = Number(p.max_context_tokens);
}

function toggleTool(name, checked) {
  const list = configForm.value.tools.enabled_tools;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.tools.enabled_tools = list.filter(item => item !== name);
  }
}

function toggleSkill(name, checked) {
  const list = configForm.value.skills.enabled_skills;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.skills.enabled_skills = list.filter(item => item !== name);
  }
}

function toggleMcpServer(name, checked) {
  const list = configForm.value.mcp.enabled_servers;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.mcp.enabled_servers = list.filter(item => item !== name);
  }
}

function toggleMemoryScope(field, scope, checked) {
  const list = configForm.value.memory[field];
  if (checked && !list.includes(scope)) {
    list.push(scope);
  } else if (!checked) {
    configForm.value.memory[field] = list.filter(item => item !== scope);
  }

  if (field === 'allowed_scopes' && !checked) {
    configForm.value.memory.write_scopes = configForm.value.memory.write_scopes.filter(item => item !== scope);
    configForm.value.memory.archive_scopes = configForm.value.memory.archive_scopes.filter(item => item !== scope);
  }
  if ((field === 'write_scopes' || field === 'archive_scopes') && checked && !configForm.value.memory.allowed_scopes.includes(scope)) {
    configForm.value.memory.allowed_scopes.push(scope);
  }
}

function toggleDelegation(name, checked) {
  const list = configForm.value.delegation.enabled_agents;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.delegation.enabled_agents = list.filter(item => item !== name);
  }
}

// 新建 Agent 对话框
const createDialog = ref({ visible: false, loading: false, agentName: '', displayName: '', description: '' });
const createDialogPanelRef = ref(null);

usePointerDownOutside({
  inside: [createDialogPanelRef],
  enabled: () => createDialog.value.visible,
  onOutside: closeCreateDialog,
});

function openCreateDialog() {
  createDialog.value = { visible: true, loading: false, agentName: '', displayName: '', description: '' };
}

function closeCreateDialog() {
  createDialog.value.visible = false;
}

async function handleCreateAgent() {
  const name = createDialog.value.agentName;
  if (!name) return;
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    showToast('Agent 名称只能包含英文字母、数字和下划线');
    return;
  }
  createDialog.value.loading = true;
  try {
    const payload = { agent_name: name };
    if (createDialog.value.displayName) payload.display_name = createDialog.value.displayName;
    if (createDialog.value.description) payload.description = createDialog.value.description;
    await createAgent(payload);
    // 刷新 agent 列表并切换到新 agent
    const configs = await getAllAgentConfigs();
    agents.value = Object.keys(configs || {});
    agentDisplayMap.value = Object.fromEntries(
      Object.entries(configs || {}).map(([n, cfg]) => [n, cfg?.display_name || n])
    );
    selectedAgent.value = name;
    await loadAgentDetail(name);
    showToast(`Agent "${name}" 创建成功`, 'success');
  } catch (err) {
    showToast(err.message || '创建 Agent 失败');
  } finally {
    createDialog.value.loading = false;
  }
}

// 删除 Agent 对话框
const deleteDialog = ref({ visible: false, loading: false, agentName: '' });
const deleteDialogPanelRef = ref(null);

usePointerDownOutside({
  inside: [deleteDialogPanelRef],
  enabled: () => deleteDialog.value.visible,
  onOutside: closeDeleteDialog,
});

function openDeleteDialog() {
  deleteDialog.value = { visible: true, loading: false, agentName: selectedAgent.value };
}

function closeDeleteDialog() {
  deleteDialog.value.visible = false;
}

async function handleDeleteAgent() {
  const name = deleteDialog.value.agentName;
  if (!name) return;
  deleteDialog.value.loading = true;
  try {
    await deleteAgent(name);
    const configs = await getAllAgentConfigs();
    agents.value = Object.keys(configs || {});
    closeDeleteDialog();
    // 切换到第一个可用 agent
    if (agents.value.length > 0) {
      selectedAgent.value = agents.value[0];
      await loadAgentDetail(agents.value[0]);
    } else {
      selectedAgent.value = '';
      configForm.value = createEmptyForm();
      rawConfig.value = createEmptyForm();
    }
    showToast(`Agent "${name}" 已删除`, 'success');
  } catch (err) {
    showToast(err.message || '删除 Agent 失败');
  } finally {
    deleteDialog.value.loading = false;
  }
}

async function handleExport() {
  if (!selectedAgent.value) return;
  try {
    const url = `/api/agent-config/configs/${encodeURIComponent(selectedAgent.value)}/export?format=yaml`;
    const response = await fetch(url);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.detail || result.message || '导出失败');
    }
    const blob = await response.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${selectedAgent.value}.yaml`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    showToast(err.message || '导出配置失败');
  }
}

watch(
  () => configForm.value.custom_params?.behavior?.system_prompt,
  () => nextTick(() => autoResizeSystemPrompt())
);

watch(
  () => [selectedAgent.value, loading.value, error.value],
  async () => {
    await nextTick();
    resetSectionObserver();
  }
);

watch(tiersCollapsed, async () => {
  await nextTick();
  resetSectionObserver();
});

onMounted(() => {
  loadInitialData();
  nextTick(() => {
    autoResizeSystemPrompt();
    resetSectionObserver();
  });

  window.addEventListener('resize', updateSliderPosition);
});

onUnmounted(() => {
  observer?.disconnect();
  if (observeTimer) clearTimeout(observeTimer);
  scrollContainerEl?.removeEventListener('scroll', updateActiveSectionByScroll);
  window.removeEventListener('resize', updateSliderPosition);
  if (scrollTimeout) clearTimeout(scrollTimeout);
});
</script>

<style scoped src="../styles/agent-config.css"></style>
<style scoped>
.team-banner {
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
}

.team-banner strong {
  color: var(--color-text-primary);
}

.skill-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.skill-group__hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: -4px;
}
</style>
