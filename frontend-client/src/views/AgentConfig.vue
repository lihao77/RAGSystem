<template>
  <div class="agent-config-page">
    <div class="config-top">
      <div class="config-top__inner">
        <!-- 桌面端头部 -->
        <div class="header-left header-left--desktop">
          <div class="header-meta">
            <h1 class="config-title">Agent 配置</h1>
            <p class="config-subtitle">统一管理智能体基础参数、模型、工具与 Skills</p>
          </div>
          <div class="header-actions">
            <CustomSelect
              id="agent-select"
              :model-value="selectedAgent"
              :options="agents.map(a => ({ value: a, label: a }))"
              placeholder="请选择 Agent"
              style="width: 200px"
              @update:model-value="selectedAgent = $event; handleAgentChange()"
            />
            <button class="pl-btn" :disabled="saving || agentLoading" title="新建 Agent" @click="openCreateDialog">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              新建
            </button>
            <button v-if="selectedAgent" class="pl-btn pl-btn--danger" :disabled="saving || agentLoading" title="删除当前 Agent" @click="openDeleteDialog">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                <path d="M10 11v6"></path>
                <path d="M14 11v6"></path>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
              </svg>
              删除
            </button>
            <button v-if="selectedAgent" class="pl-btn" :disabled="agentLoading" title="导出配置" @click="handleExport">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              导出
            </button>
            <button v-if="selectedAgent" class="pl-btn pl-btn--primary" :disabled="saving || agentLoading" @click="handleSave">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
              </svg>
              {{ saving ? '保存中...' : '保存配置' }}
            </button>
            <button class="pl-btn" @click="navigateToChat">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
              返回聊天
            </button>
          </div>
        </div>

        <!-- 移动端头部 -->
        <div class="mobile-nav">
          <button class="mobile-nav__back" @click="navigateToChat">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>

          <button class="mobile-nav__title" @click="mobileAgentPickerOpen = !mobileAgentPickerOpen">
            <span class="mobile-nav__title-text">{{ selectedAgent || 'Agent 配置' }}</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" :style="{ transform: mobileAgentPickerOpen ? 'rotate(180deg)' : '', transition: 'transform 0.2s' }">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>

          <button class="mobile-nav__more" @click="mobileMenuOpen = !mobileMenuOpen">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="5" r="1" fill="currentColor"></circle>
              <circle cx="12" cy="12" r="1" fill="currentColor"></circle>
              <circle cx="12" cy="19" r="1" fill="currentColor"></circle>
            </svg>
          </button>

          <!-- Agent 切换下拉列表 -->
          <div v-if="mobileAgentPickerOpen" class="mobile-picker" @click.self="mobileAgentPickerOpen = false">
            <div class="mobile-picker__list">
              <button
                v-for="a in agents"
                :key="a"
                class="mobile-picker__item"
                :class="{ active: a === selectedAgent }"
                @click="selectedAgent = a; handleAgentChange(); mobileAgentPickerOpen = false"
              >
                <svg v-if="a === selectedAgent" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span>{{ a }}</span>
              </button>
            </div>
          </div>

          <!-- 三点操作菜单 -->
          <div v-if="mobileMenuOpen" class="mobile-menu" @click.self="mobileMenuOpen = false">
            <button class="pl-menu-item" :disabled="saving || agentLoading" @click="openCreateDialog(); mobileMenuOpen = false">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              新建 Agent
            </button>
            <button v-if="selectedAgent" class="pl-menu-item" :disabled="saving || agentLoading" @click="handleSave(); mobileMenuOpen = false">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
              </svg>
              {{ saving ? '保存中...' : '保存配置' }}
            </button>
            <button v-if="selectedAgent" class="pl-menu-item" :disabled="agentLoading" @click="handleExport(); mobileMenuOpen = false">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              导出配置
            </button>
            <div v-if="selectedAgent" class="pl-menu-divider"></div>
            <button v-if="selectedAgent" class="pl-menu-item pl-menu-item--danger" :disabled="saving || agentLoading" @click="openDeleteDialog(); mobileMenuOpen = false">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                <path d="M10 11v6"></path>
                <path d="M14 11v6"></path>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
              </svg>
              删除 Agent
            </button>
          </div>
        </div>
      </div>
    </div>

    <div ref="configBodyRef" class="config-body">
      <div v-if="loading" class="state-panel state-panel--loading">
        <div class="spinner"></div>
        <p>加载中...</p>
      </div>

      <div v-else-if="error" class="state-panel state-panel--error">
        <p>{{ error }}</p>
        <button class="pl-btn" @click="loadInitialData">重试</button>
      </div>

      <template v-else>
        <div v-if="!selectedAgent" class="state-panel state-panel--empty">
          <p>暂无可配置的 Agent</p>
        </div>

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

              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.enabled" type="checkbox" />
                <span class="field-label-text">启用该 Agent</span>
              </label>

              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.default_entry" type="checkbox" />
                <span class="field-label-text">设为默认入口 Agent</span>
              </label>
            </div>
          </section>

          <section id="section-llm" class="form-section">
            <div class="section-head">
              <h2>LLM 配置</h2>
              <span>Provider 自动同步默认参数，可按需覆盖</span>
            </div>
            <div class="section-body form-grid">
              <label class="form-item">
                <span class="field-label-text">Provider</span>
                <CustomSelect
                  :model-value="selectedProviderKey"
                  :options="[{ value: '', label: '未设置（使用默认）' }, ...providers.map(p => ({ value: p.key || p.name, label: p.name + (p.provider_type ? ` (${p.provider_type})` : '') }))]"
                  placeholder="未设置（使用默认）"
                  @update:model-value="selectedProviderKey = $event; handleProviderChange()"
                />
              </label>

              <label class="form-item">
                <span class="field-label-text">Provider Type</span>
                <input :value="configForm.llm.provider_type || '未设置'" type="text" class="form-control" disabled />
                <small class="field-hint">只读字段，随 Provider 自动更新</small>
              </label>

              <label class="form-item">
                <span class="field-label-text">Model Name</span>
                <CustomSelect
                  :model-value="configForm.llm.model_name"
                  :options="[{ value: '', label: '选择模型' }, ...providerModelOptions.map(m => ({ value: m, label: m }))]"
                  placeholder="选择模型"
                  @update:model-value="configForm.llm.model_name = $event; handleModelChange()"
                />
                <small class="field-hint">可从列表选择，或保存后手动编辑配置文件指定自定义模型</small>
              </label>

              <label class="form-item">
                <span class="field-label-text">Temperature</span>
                <NumberInput :model-value="configForm.llm.temperature" :min="0" :max="2" :step="0.1" @update:model-value="configForm.llm.temperature = $event" />
              </label>

              <label class="form-item">
                <span class="field-label-text">Max Completion Tokens</span>
                <NumberInput :model-value="configForm.llm.max_completion_tokens" :min="1" :step="1" @update:model-value="configForm.llm.max_completion_tokens = $event" />
              </label>

              <label class="form-item">
                <span class="field-label-text">Max Context Tokens</span>
                <NumberInput :model-value="configForm.llm.max_context_tokens" :min="1" :step="1" @update:model-value="configForm.llm.max_context_tokens = $event" />
              </label>

              <label class="form-item">
                <span class="field-label-text">Retry Attempts</span>
                <NumberInput :model-value="configForm.llm.retry_attempts" :min="1" :step="1" @update:model-value="configForm.llm.retry_attempts = $event" />
              </label>

              <label class="form-item">
                <span class="field-label-text">退避指数</span>
                <NumberInput :model-value="configForm.llm.retry_backoff_factor" :min="1" :max="10" :step="0.1" @update:model-value="configForm.llm.retry_backoff_factor = $event" />
              </label>
            </div>
          </section>

          <section id="section-tiers" class="form-section">
            <div class="section-head">
              <h2>LLM 分层配置</h2>
              <span>可选。fast 用于压缩等简单任务，powerful 用于复杂推理</span>
            </div>
            <div class="section-body">
              <div v-for="tier in ['fast', 'powerful']" :key="tier" class="tier-block">
                <div class="tier-block__head">
                  <div class="toggle-card"
                    :class="{ active: !!configForm.llm_tiers[tier] }"
                    style="flex:1"
                    @click="configForm.llm_tiers[tier] = configForm.llm_tiers[tier] ? null : createEmptyLLM()"
                  >
                    <div class="toggle-card__indicator">
                      <svg v-if="configForm.llm_tiers[tier]"
                        xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                    <div class="toggle-card__name">{{ tier }}</div>
                    <div class="toggle-card__desc">{{ tier === 'fast' ? '简单任务（压缩、格式化等），成本优化' : '复杂推理任务（可选）' }}</div>
                  </div>
                </div>
                <div v-if="configForm.llm_tiers[tier]" class="form-grid tier-block__body">
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
                  <label class="form-item">
                    <span class="field-label-text">Retry Attempts</span>
                    <NumberInput :model-value="configForm.llm_tiers[tier].retry_attempts" :min="1" :step="1" @update:model-value="configForm.llm_tiers[tier].retry_attempts = $event" />
                  </label>
                  <label class="form-item">
                    <span class="field-label-text">退避指数</span>
                    <NumberInput :model-value="configForm.llm_tiers[tier].retry_backoff_factor" :min="1" :max="10" :step="0.1" @update:model-value="configForm.llm_tiers[tier].retry_backoff_factor = $event" />
                  </label>
                </div>
              </div>
            </div>
          </section>

          <section id="section-prompt" class="form-section">
            <div class="section-head">
              <h2>System Prompt</h2>
              <span>编辑 custom_params.behavior.system_prompt</span>
            </div>
            <div class="section-body">
              <label class="form-item">
                <span class="field-label-text">System Prompt</span>
                <textarea v-model="configForm.custom_params.behavior.system_prompt" class="form-control form-control--textarea" rows="8" placeholder="请输入该 Agent 的 system prompt"></textarea>
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

          <section id="section-skills" class="form-section">
            <div class="section-head">
              <h2>Skills</h2>
              <span>管理领域知识与脚本能力注入</span>
            </div>
            <div class="section-body skills-body">
              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.skills.auto_inject" type="checkbox" />
                <span>自动注入 Skills</span>
              </label>

              <div class="toggle-grid">
                <div
                  v-for="skill in skills"
                  :key="skill.name"
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
          </section>

          <section id="section-memory" class="form-section">
            <div class="section-head">
              <h2>Memory</h2>
              <span>像 Skill 一样按 Agent 控制 memory 注入与工具权限</span>
            </div>
            <div class="section-body skills-body">
              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.memory.enabled" type="checkbox" />
                <span>启用 Memory</span>
              </label>
              <label class="form-item checkbox-item checkbox-item--inline">
                <input v-model="configForm.memory.auto_inject" type="checkbox" :disabled="!configForm.memory.enabled" />
                <span>自动注入 MEMORY 索引</span>
              </label>

              <div class="subsection-title">Memory 工具</div>
              <div class="toggle-grid">
                <div
                  v-for="toolName in ['list_memory_index', 'read_memory_entry', 'write_memory', 'archive_memory']"
                  :key="toolName"
                  class="toggle-card"
                  :class="{ active: configForm.memory.enabled_tools.includes(toolName), disabled: !configForm.memory.enabled }"
                  @click="configForm.memory.enabled && toggleMemoryTool(toolName, !configForm.memory.enabled_tools.includes(toolName))"
                >
                  <div class="toggle-card__indicator">
                    <svg v-if="configForm.memory.enabled_tools.includes(toolName)"
                      xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                  <div class="toggle-card__name">{{ toolName }}</div>
                  <div class="toggle-card__desc">默认 memory 工具</div>
                </div>
              </div>

              <div class="subsection-title">允许访问的 Scope</div>
              <div class="toggle-grid">
                <div v-for="scope in ['project', 'session', 'agent', 'workspace']" :key="scope" class="toggle-card" :class="{ active: configForm.memory.allowed_scopes.includes(scope), disabled: !configForm.memory.enabled }" @click="configForm.memory.enabled && toggleMemoryScope('allowed_scopes', scope, !configForm.memory.allowed_scopes.includes(scope))">
                  <div class="toggle-card__indicator"><svg v-if="configForm.memory.allowed_scopes.includes(scope)" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
                  <div class="toggle-card__name">{{ scope }}</div>
                </div>
              </div>

              <div class="subsection-title">允许写入的 Scope</div>
              <div class="toggle-grid">
                <div v-for="scope in ['project', 'session', 'agent', 'workspace']" :key="`write-${scope}`" class="toggle-card" :class="{ active: configForm.memory.write_scopes.includes(scope), disabled: !configForm.memory.enabled }" @click="configForm.memory.enabled && toggleMemoryScope('write_scopes', scope, !configForm.memory.write_scopes.includes(scope))">
                  <div class="toggle-card__indicator"><svg v-if="configForm.memory.write_scopes.includes(scope)" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
                  <div class="toggle-card__name">{{ scope }}</div>
                </div>
              </div>

              <div class="subsection-title">允许归档的 Scope</div>
              <div class="toggle-grid">
                <div v-for="scope in ['project', 'session', 'agent', 'workspace']" :key="`archive-${scope}`" class="toggle-card" :class="{ active: configForm.memory.archive_scopes.includes(scope), disabled: !configForm.memory.enabled }" @click="configForm.memory.enabled && toggleMemoryScope('archive_scopes', scope, !configForm.memory.archive_scopes.includes(scope))">
                  <div class="toggle-card__indicator"><svg v-if="configForm.memory.archive_scopes.includes(scope)" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></div>
                  <div class="toggle-card__name">{{ scope }}</div>
                </div>
              </div>
            </div>
          </section>

          <section id="section-mcp" class="form-section">
            <div class="section-head">
              <h2>MCP 服务</h2>
              <span>将已配置的 MCP Server 工具授权给当前 Agent</span>
            </div>
            <div class="section-body">
              <div v-if="mcpServers.length === 0" class="state-panel state-panel--empty state-panel--compact">
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
                  <div class="toggle-card__desc">{{ server.transport || 'stdio' }} / {{ server.status || 'unknown' }} / {{ server.tool_count || 0 }} tools</div>
                  <div class="toggle-card__meta">
                    <span>{{ server.enabled ? '已启用' : '已禁用' }}</span>
                    <span v-if="server.error_message">{{ server.error_message }}</span>
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

      <nav v-if="selectedAgent && !loading && !error" class="section-nav section-nav--desktop">
        <a v-for="s in sections" :key="s.id" :class="{ active: activeSection === s.id }" :title="s.label" @click="scrollToSection(s.id)">
          <span class="section-nav__dot"></span>
          <span class="section-nav__label">{{ s.label }}</span>
        </a>
      </nav>
    </div>

    <button class="btn-scroll-bottom" title="滚动到底部" @click="scrollToBottom">
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>

    <nav v-if="selectedAgent && !loading && !error" class="section-nav section-nav--mobile">
      <a v-for="s in sections" :key="s.id" :class="{ active: activeSection === s.id }" @click="scrollToSection(s.id)">
        <span class="section-nav__label-inner">{{ s.label }}</span>
      </a>
    </nav>

    <AppToast ref="toastRef" />

    <!-- 新建 Agent 对话框 -->
    <Teleport to="body">
      <div v-if="createDialog.visible" class="modal-overlay" @click.self="closeCreateDialog">
        <div class="modal-panel">
          <div class="modal-head">
            <h3>新建 Agent</h3>
            <button class="modal-close" @click="closeCreateDialog">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <label class="form-item">
              <span class="field-label-text">Agent 名称 <em class="required-mark">*</em></span>
              <input
                v-model.trim="createDialog.agentName"
                type="text"
                class="form-control"
                placeholder="仅限英文、数字和下划线，如 my_agent"
                @keydown.enter="handleCreateAgent"
              />
              <small class="field-hint">创建后不可修改，将作为唯一标识符</small>
            </label>
            <label class="form-item">
              <span class="field-label-text">显示名称</span>
              <input v-model.trim="createDialog.displayName" type="text" class="form-control" placeholder="可选，留空则使用 Agent 名称" @keydown.enter="handleCreateAgent" />
            </label>
            <label class="form-item">
              <span class="field-label-text">描述</span>
              <input v-model.trim="createDialog.description" type="text" class="form-control" placeholder="可选" @keydown.enter="handleCreateAgent" />
            </label>
          </div>
          <div class="modal-foot">
            <button class="pl-btn" :disabled="createDialog.loading" @click="closeCreateDialog">取消</button>
            <button class="pl-btn pl-btn--primary" :disabled="createDialog.loading || !createDialog.agentName" @click="handleCreateAgent">
              {{ createDialog.loading ? '创建中...' : '创建' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 删除 Agent 确认对话框 -->
    <Teleport to="body">
      <div v-if="deleteDialog.visible" class="modal-overlay" @click.self="closeDeleteDialog">
        <div class="modal-panel modal-panel--sm">
          <div class="modal-head">
            <h3>删除 Agent</h3>
            <button class="modal-close" @click="closeDeleteDialog">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
          <div class="modal-body">
            <p class="delete-confirm-text">确定要删除 Agent <strong>{{ deleteDialog.agentName }}</strong> 吗？此操作不可撤销。</p>
          </div>
          <div class="modal-foot">
            <button class="pl-btn" :disabled="deleteDialog.loading" @click="closeDeleteDialog">取消</button>
            <button class="pl-btn pl-btn--danger" :disabled="deleteDialog.loading" @click="handleDeleteAgent">
              {{ deleteDialog.loading ? '删除中...' : '确认删除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import {
  getAllAgentConfigs,
  getAgentConfig,
  updateAgentConfig,
  createAgent,
  deleteAgent,
  getAvailableTools,
  getAvailableSkills,
  getAvailableMCPServers
} from '../api/agentConfig';
import { getProviders } from '../api/modelAdapter';
import CustomSelect from '../components/CustomSelect.vue';
import NumberInput from '../components/NumberInput.vue';
import AppToast from '../components/AppToast.vue';
import { useRouter } from 'vue-router';

const router = useRouter();

const sections = [
  { id: 'section-basic', label: '基础' },
  { id: 'section-llm', label: 'LLM' },
  { id: 'section-tiers', label: '分层' },
  { id: 'section-prompt', label: 'Prompt' },
  { id: 'section-tools', label: '工具' },
  { id: 'section-skills', label: 'Skills' },
  { id: 'section-memory', label: 'Memory' },
  { id: 'section-mcp', label: 'MCP' },
  { id: 'section-delegation', label: '委派' }
];
const activeSection = ref('section-basic');
let observer = null;
let isClickScrolling = false;
let scrollTimeout = null;

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
  // 标记为点击滚动，暂停观察器
  isClickScrolling = true;
  activeSection.value = id;
  updateSliderPosition();

  // 清除之前的 timeout
  if (scrollTimeout) clearTimeout(scrollTimeout);

  const element = document.getElementById(id);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // 滚动动画完成后恢复观察（约 500ms 后）
    scrollTimeout = setTimeout(() => {
      isClickScrolling = false;
    }, 600);
  }
}

const configBodyRef = ref(null);

function scrollToBottom() {
  const el = configBodyRef.value;
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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
const selectedAgent = ref('');
const tools = ref([]);
const skills = ref([]);
const mcpServers = ref([]);
const providers = ref([]);

const configForm = ref(createEmptyForm());
const rawConfig = ref(createEmptyForm());
const selectedProviderKey = ref('');

const selectedProviderEntry = computed(() => {
  if (!selectedProviderKey.value) return null;
  return providers.value.find(item => (item?.key || item?.name) === selectedProviderKey.value) || null;
});

function getProviderModels(provider) {
  if (!provider) return [];

  const fromMap = provider.model_map?.chat;
  if (fromMap != null) {
    if (Array.isArray(fromMap)) return fromMap.filter(Boolean);
    return [String(fromMap)];
  }

  if (Array.isArray(provider.models) && provider.models.length > 0) {
    return provider.models.filter(Boolean);
  }

  if (provider.model) return [provider.model];
  return [];
}

const providerModelOptions = computed(() => {
  return getProviderModels(selectedProviderEntry.value);
});

function createEmptyLLM() {
  return {
    provider: '',
    provider_type: '',
    model_name: '',
    temperature: 0.7,
    max_completion_tokens: 4096,
    max_context_tokens: 128000,
    retry_attempts: 10,
    retry_backoff_factor: 2.5
  };
}

function createEmptyForm() {
  return {
    agent_name: '',
    display_name: '',
    description: '',
    enabled: true,
    default_entry: false,
    llm: createEmptyLLM(),
    llm_tiers: { fast: null, powerful: null },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      enabled: false,
      auto_inject: true,
      enabled_tools: [],
      allowed_scopes: ['project', 'session'],
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
    retry_attempts: tier.retry_attempts ?? 10,
    retry_backoff_factor: tier.retry_backoff_factor ?? 2.5
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
    llm: {
      provider: safeConfig.llm?.provider || '',
      provider_type: safeConfig.llm?.provider_type || '',
      model_name: safeConfig.llm?.model_name || '',
      temperature: safeConfig.llm?.temperature ?? 0.7,
      max_completion_tokens: safeConfig.llm?.max_completion_tokens ?? 4096,
      max_context_tokens: safeConfig.llm?.max_context_tokens ?? 128000,
      retry_attempts: safeConfig.llm?.retry_attempts ?? 10,
      retry_backoff_factor: safeConfig.llm?.retry_backoff_factor ?? 2.5
    },
    llm_tiers: {
      fast: parseTierLLM(safeConfig.llm_tiers?.fast),
      powerful: parseTierLLM(safeConfig.llm_tiers?.powerful)
    },
    tools: {
      enabled_tools: Array.isArray(safeConfig.tools?.enabled_tools) ? [...safeConfig.tools.enabled_tools] : []
    },
    skills: {
      enabled_skills: Array.isArray(safeConfig.skills?.enabled_skills) ? [...safeConfig.skills.enabled_skills] : [],
      auto_inject: safeConfig.skills?.auto_inject ?? true
    },
    mcp: {
      enabled_servers: Array.isArray(safeConfig.mcp?.enabled_servers) ? [...safeConfig.mcp.enabled_servers] : []
    },
    memory: {
      enabled: safeConfig.memory?.enabled ?? false,
      auto_inject: safeConfig.memory?.auto_inject ?? true,
      enabled_tools: Array.isArray(safeConfig.memory?.enabled_tools) ? [...safeConfig.memory.enabled_tools] : [],
      allowed_scopes: Array.isArray(safeConfig.memory?.allowed_scopes) ? [...safeConfig.memory.allowed_scopes] : ['project', 'session'],
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

  const matched = providers.value.find(item =>
    item?.name === configForm.value.llm.provider &&
    (!configForm.value.llm.provider_type || item?.provider_type === configForm.value.llm.provider_type)
  );
  selectedProviderKey.value = matched ? (matched.key || matched.name) : '';
}

function buildPayload() {
  const merged = JSON.parse(JSON.stringify(rawConfig.value || {}));
  merged.agent_name = selectedAgent.value;
  merged.display_name = configForm.value.display_name;
  merged.description = configForm.value.description;
  merged.enabled = configForm.value.enabled;
  merged.default_entry = !!configForm.value.default_entry;

  merged.llm = {
    ...(merged.llm || {}),
    provider: configForm.value.llm.provider || null,
    provider_type: configForm.value.llm.provider_type || null,
    model_name: configForm.value.llm.model_name || null,
    temperature: configForm.value.llm.temperature === '' ? null : Number(configForm.value.llm.temperature),
    max_completion_tokens: configForm.value.llm.max_completion_tokens === '' ? null : Number(configForm.value.llm.max_completion_tokens),
    max_context_tokens: configForm.value.llm.max_context_tokens === '' ? null : Number(configForm.value.llm.max_context_tokens),
    retry_attempts: configForm.value.llm.retry_attempts === '' ? null : Number(configForm.value.llm.retry_attempts),
    retry_backoff_factor: configForm.value.llm.retry_backoff_factor === '' ? null : Number(configForm.value.llm.retry_backoff_factor)
  };

  function buildTier(tier) {
    if (!tier) return null;
    return {
      provider: tier.provider || null,
      provider_type: tier.provider_type || null,
      model_name: tier.model_name || null,
      temperature: tier.temperature === '' ? null : Number(tier.temperature),
      max_completion_tokens: tier.max_completion_tokens === '' ? null : Number(tier.max_completion_tokens),
      max_context_tokens: tier.max_context_tokens === '' ? null : Number(tier.max_context_tokens),
      retry_attempts: tier.retry_attempts === '' ? null : Number(tier.retry_attempts),
      retry_backoff_factor: tier.retry_backoff_factor === '' ? null : Number(tier.retry_backoff_factor)
    };
  }
  const tiers = configForm.value.llm_tiers;
  const builtTiers = {};
  if (tiers.fast) builtTiers.fast = buildTier(tiers.fast);
  if (tiers.powerful) builtTiers.powerful = buildTier(tiers.powerful);
  merged.llm_tiers = Object.keys(builtTiers).length ? builtTiers : null;

  merged.tools = {
    ...(merged.tools || {}),
    enabled_tools: configForm.value.tools.enabled_tools
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
    ...(merged.memory || {}),
    enabled: !!configForm.value.memory.enabled,
    auto_inject: !!configForm.value.memory.auto_inject,
    enabled_tools: configForm.value.memory.enabled_tools,
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

async function loadInitialData() {
  loading.value = true;
  error.value = '';

  try {
    const [configs, toolList, skillList, mcpServerList, providerList] = await Promise.all([
      getAllAgentConfigs(),
      getAvailableTools(),
      getAvailableSkills(),
      getAvailableMCPServers(),
      getProviders()
    ]);

    tools.value = Array.isArray(toolList) ? toolList : [];
    skills.value = Array.isArray(skillList) ? skillList : [];
    mcpServers.value = Array.isArray(mcpServerList) ? mcpServerList : [];
    providers.value = Array.isArray(providerList) ? providerList : [];

    const agentNames = Object.keys(configs || {});
    agents.value = agentNames;

    if (agentNames.length > 0) {
      selectedAgent.value = agentNames[0];
      await loadAgentDetail(agentNames[0]);
    } else {
      selectedAgent.value = '';
      configForm.value = createEmptyForm();
      rawConfig.value = createEmptyForm();
    }
  } catch (err) {
    error.value = err.message || '加载 Agent 配置失败';
  } finally {
    loading.value = false;
  }
}

async function loadAgentDetail(agentName) {
  if (!agentName) return;

  agentLoading.value = true;

  try {
    const config = await getAgentConfig(agentName);
    applyConfigToForm(config);
  } catch (err) {
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

  if (!configForm.value.llm.provider) {
    showToast('请选择主 LLM 的 Provider');
    return;
  }
  for (const tier of ['fast', 'powerful']) {
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
  if (p.retry_attempts != null) t.retry_attempts = Number(p.retry_attempts);
  if (p.retry_backoff_factor != null) t.retry_backoff_factor = Number(p.retry_backoff_factor);
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

function toggleMemoryTool(name, checked) {
  const list = configForm.value.memory.enabled_tools;
  if (checked && !list.includes(name)) {
    list.push(name);
  } else if (!checked) {
    configForm.value.memory.enabled_tools = list.filter(item => item !== name);
  }
}

function toggleMemoryScope(field, scope, checked) {
  const list = configForm.value.memory[field];
  if (checked && !list.includes(scope)) {
    list.push(scope);
  } else if (!checked) {
    configForm.value.memory[field] = list.filter(item => item !== scope);
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

function syncLLMWithProviderDefaults({ keepCurrentModel = true } = {}) {
  const provider = selectedProviderEntry.value;
  if (!provider) return;

  configForm.value.llm.provider = provider.name || '';
  configForm.value.llm.provider_type = provider.provider_type || '';

  const models = getProviderModels(provider);
  const currentModel = configForm.value.llm.model_name;
  if (!keepCurrentModel || !currentModel || !models.includes(currentModel)) {
    configForm.value.llm.model_name = models[0] || provider.model || currentModel || '';
  }

  if (provider.temperature != null) {
    configForm.value.llm.temperature = Number(provider.temperature);
  }
  if (provider.max_completion_tokens != null) {
    configForm.value.llm.max_completion_tokens = Number(provider.max_completion_tokens);
  }
  if (provider.max_context_tokens != null) {
    configForm.value.llm.max_context_tokens = Number(provider.max_context_tokens);
  }
  if (provider.retry_attempts != null) {
    configForm.value.llm.retry_attempts = Number(provider.retry_attempts);
  }
  if (provider.retry_backoff_factor != null) {
    configForm.value.llm.retry_backoff_factor = Number(provider.retry_backoff_factor);
  }
}

function handleProviderChange() {
  if (!selectedProviderKey.value) {
    configForm.value.llm.provider = '';
    configForm.value.llm.provider_type = '';
    return;
  }

  syncLLMWithProviderDefaults({ keepCurrentModel: false });
}

function handleModelChange() {
  syncLLMWithProviderDefaults({ keepCurrentModel: true });
}

function navigateToChat() {
  router.push('/');
}

// 新建 Agent 对话框
const createDialog = ref({ visible: false, loading: false, agentName: '', displayName: '', description: '' });

// 移动端菜单状态
const mobileMenuOpen = ref(false);
const mobileAgentPickerOpen = ref(false);

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
    closeCreateDialog();
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

onMounted(() => {
  loadInitialData();
  observer = new IntersectionObserver(
    (entries) => {
      // 点击滚动期间忽略观察结果
      if (isClickScrolling) return;

      // 按可见比例排序，取可见比例最大的
      const visibleEntries = entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

      if (visibleEntries.length > 0) {
        const newSection = visibleEntries[0].target.id;
        if (newSection !== activeSection.value) {
          activeSection.value = newSection;
          updateSliderPosition();
        }
      }
    },
    {
      root: document.querySelector('.config-body'),
      threshold: [0, 0.25, 0.5, 0.75, 1],
      rootMargin: '-10% 0px -60% 0px'
    }
  );
  setTimeout(() => {
    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    // 初始化滑块位置
    updateSliderPosition();
  }, 500);

  // 监听窗口大小变化，更新滑块位置
  window.addEventListener('resize', updateSliderPosition);
});

onUnmounted(() => {
  observer?.disconnect();
  window.removeEventListener('resize', updateSliderPosition);
  if (scrollTimeout) clearTimeout(scrollTimeout);
});
</script>

<style scoped src="../styles/agent-config.css"></style>
