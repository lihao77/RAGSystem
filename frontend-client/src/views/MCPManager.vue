<template>
  <div class="mcp-page">
  <div class="mcp-shell">

    <!-- ── 顶部 Header ─────────────────────────────────────── -->
    <header class="mcp-header glass-card">
      <div class="header-meta">
        <h1 class="page-title">MCP 服务管理</h1>
        <p class="page-subtitle">搜索 Registry、安装模板、测试连接，统一管理 MCP 工具服务。</p>
      </div>
      <div class="header-actions">
        <button class="btn-action" :disabled="loadingServers" @click="refreshAll">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          {{ loadingServers ? '刷新中...' : '全局刷新' }}
        </button>
        <button class="btn-back" @click="emit('navigate', '/')">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"/>
            <polyline points="12 19 5 12 12 5"/>
          </svg>
          返回聊天
        </button>
      </div>
    </header>

    <!-- ── 统计卡片 ────────────────────────────────────────── -->
    <section class="summary-grid">
      <article class="summary-card glass-card">
        <div class="summary-icon summary-icon--total">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <div class="summary-body">
          <span class="summary-label">服务总数</span>
          <strong class="summary-value">{{ summary.total }}</strong>
        </div>
      </article>

      <article class="summary-card glass-card">
        <div class="summary-icon summary-icon--connected">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12.55a11 11 0 0 1 14.08 0"/>
            <path d="M1.42 9a16 16 0 0 1 21.16 0"/>
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
            <line x1="12" y1="20" x2="12.01" y2="20"/>
          </svg>
        </div>
        <div class="summary-body">
          <span class="summary-label">已连接</span>
          <strong class="summary-value summary-value--connected">{{ summary.connected }}</strong>
        </div>
      </article>

      <article class="summary-card glass-card">
        <div class="summary-icon summary-icon--enabled">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <div class="summary-body">
          <span class="summary-label">已启用</span>
          <strong class="summary-value summary-value--enabled">{{ summary.enabled }}</strong>
        </div>
      </article>

      <article class="summary-card glass-card">
        <div class="summary-icon summary-icon--tools">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
        </div>
        <div class="summary-body">
          <span class="summary-label">可用工具</span>
          <strong class="summary-value summary-value--tools">{{ summary.tools }}</strong>
        </div>
      </article>
    </section>

    <!-- ── Tab 导航 ───────────────────────────────────────── -->
    <nav class="tab-nav glass-card">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab-btn"
        :class="{ 'tab-btn--active': activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        <span class="tab-icon" v-html="tab.icon"></span>
        {{ tab.label }}
        <span v-if="tab.badge" class="tab-badge">{{ tab.badge }}</span>
      </button>
    </nav>

    <!-- ── Tab: 已安装服务 ─────────────────────────────────── -->
    <section v-if="activeTab === 'installed'" class="tab-content">
      <div class="section-toolbar">
        <div class="toolbar-left">
          <h2 class="section-title">已安装服务</h2>
          <p class="section-desc">管理连接状态、查看工具、修改运行参数。</p>
        </div>
        <button class="btn-action" :disabled="loadingServers" @click="loadServers">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          刷新
        </button>
      </div>

      <div v-if="loadingServers" class="state-panel">
        <div class="spinner"></div>
        <p>正在加载 MCP 服务...</p>
      </div>
      <div v-else-if="!servers.length" class="state-panel state-panel--empty">
        <div class="empty-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </div>
        <p class="empty-title">暂无 MCP 服务</p>
        <p class="empty-hint">前往「模板安装」或「Registry」标签页添加服务</p>
      </div>
      <div v-else class="server-grid">
        <article v-for="server in servers" :key="server.name" class="server-card glass-card">
          <!-- 卡片顶部：名称 + 状态 -->
          <div class="server-card-head">
            <div class="server-card-icon" :class="`server-icon--${server.transport || 'stdio'}`">
              <svg v-if="(server.transport || 'stdio') === 'stdio'" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
              </svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </div>
            <div class="server-card-info">
              <div class="server-card-name">{{ server.display_name || server.name }}</div>
              <div class="server-card-id">{{ server.name }}</div>
            </div>
            <div class="server-card-badges">
              <span class="status-dot" :class="`status-dot--${server.status || 'unknown'}`" :title="server.status || 'unknown'"></span>
              <span class="badge" :class="statusBadgeClass(server.status)">{{ server.status || 'unknown' }}</span>
            </div>
          </div>

          <!-- 元数据行 -->
          <div class="server-meta-row">
            <div class="meta-chip">
              <span class="meta-chip-label">传输</span>
              <span class="meta-chip-value meta-chip-value--mono">{{ server.transport || 'stdio' }}</span>
            </div>
            <div class="meta-chip">
              <span class="meta-chip-label">工具</span>
              <span class="meta-chip-value">{{ server.tool_count || 0 }}</span>
            </div>
            <div class="meta-chip">
              <span class="meta-chip-label">风险</span>
              <span class="meta-chip-value" :class="`risk--${server.risk_level || 'medium'}`">{{ server.risk_level || 'medium' }}</span>
            </div>
            <div class="meta-chip">
              <span class="meta-chip-label">状态</span>
              <span class="meta-chip-value" :class="server.enabled ? 'text-success' : 'text-muted'">
                {{ server.enabled ? '已启用' : '已禁用' }}
              </span>
            </div>
          </div>

          <!-- 接入信息 -->
          <div class="server-connection-info">
            <code class="connection-code">
              {{ server.transport === 'stdio'
                ? (server.command ? `${server.command} ${formatArgs(server.args)}` : '无命令')
                : (server.url || '无地址') }}
            </code>
          </div>

          <!-- 错误提示 -->
          <div v-if="server.error_message" class="error-banner">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {{ server.error_message }}
          </div>

          <!-- 操作按钮组 -->
          <div class="server-actions">
            <button class="act-btn act-btn--connect" :disabled="!server.enabled || server.status === 'connected'" @click="handleConnect(server)" title="连接">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>
              </svg>
              连接
            </button>
            <button class="act-btn act-btn--disconnect" :disabled="server.status !== 'connected'" @click="handleDisconnect(server)" title="断开">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
                <line x1="12" y1="20" x2="12.01" y2="20"/>
              </svg>
              断开
            </button>
            <button class="act-btn" @click="handleTest(server)" title="测试连接">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              测试
            </button>
            <button class="act-btn" @click="showTools(server)" title="查看工具">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
              工具 <span v-if="server.tool_count" class="act-badge">{{ server.tool_count }}</span>
            </button>
            <button class="act-btn" @click="openEditDialog(server)" title="编辑配置">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
              编辑
            </button>
            <button class="act-btn act-btn--danger" @click="handleDelete(server)" title="删除">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              删除
            </button>
          </div>
        </article>
      </div>
    </section>

    <!-- ── Tab: 模板安装 ──────────────────────────────────── -->
    <section v-if="activeTab === 'template'" class="tab-content">
      <div class="section-toolbar">
        <div class="toolbar-left">
          <h2 class="section-title">模板安装</h2>
          <p class="section-desc">从预置模板快速安装常用 MCP 服务。</p>
        </div>
        <button class="btn-action" :disabled="loadingTemplates" @click="loadTemplates">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          刷新模板
        </button>
      </div>

      <div class="install-layout">
        <!-- 模板选择侧栏 -->
        <div class="template-sidebar glass-card">
          <div class="sidebar-search">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input v-model="templateFilter" type="text" placeholder="筛选模板..." class="sidebar-search-input" />
          </div>
          <div v-if="loadingTemplates" class="sidebar-loading">
            <div class="spinner spinner--sm"></div>
          </div>
          <ul v-else class="template-list">
            <li v-if="!filteredTemplates.length" class="template-list-empty">暂无模板</li>
            <li
              v-for="tmpl in filteredTemplates"
              :key="tmpl.id"
              class="template-item"
              :class="{ 'template-item--active': installForm.template_id === tmpl.id }"
              @click="handleTemplateChange(tmpl.id)"
            >
              <div class="template-item-name">{{ tmpl.display_name }}</div>
              <div v-if="tmpl.description" class="template-item-desc">{{ tmpl.description }}</div>
            </li>
          </ul>
        </div>

        <!-- 安装表单 -->
        <div class="template-form glass-card">
          <div v-if="!selectedTemplate" class="template-placeholder">
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
            <p>← 从左侧选择一个模板</p>
          </div>

          <template v-else>
            <div class="template-detail-header">
              <div>
                <h3>{{ selectedTemplate.display_name }}</h3>
                <p>{{ selectedTemplate.description }}</p>
              </div>
              <span v-if="selectedTemplate.install_hint" class="install-hint-badge">{{ selectedTemplate.install_hint }}</span>
            </div>

            <div class="form-divider"></div>

            <div class="form-grid two-col">
              <label class="field">
                <span>服务名称</span>
                <input v-model.trim="installForm.server_name" type="text" placeholder="如 filesystem" />
              </label>
              <label class="field">
                <span>显示名称</span>
                <input v-model.trim="installForm.display_name" type="text" placeholder="前端展示名称" />
              </label>
            </div>

            <div v-if="selectedTemplate.fields?.length" class="form-grid">
              <label v-for="field in selectedTemplate.fields" :key="field.name" class="field">
                <span>{{ field.label }}<em v-if="field.required">*</em></span>
                <input
                  v-model="installForm.options[field.name]"
                  :type="field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'"
                  :placeholder="field.placeholder || ''"
                />
                <small v-if="field.help">{{ field.help }}</small>
              </label>
            </div>

            <div class="form-divider"></div>
            <div class="form-section-label">高级设置</div>

            <div class="form-grid four-col">
              <label class="field">
                <span>超时秒数</span>
                <NumberInput :model-value="installForm.timeout" :min="1" :max="300" @update:model-value="installForm.timeout = $event" />
              </label>
              <label class="field">
                <span>风险等级</span>
                <CustomSelect
                  :model-value="installForm.risk_level"
                  :options="riskOptions"
                  @update:model-value="installForm.risk_level = $event"
                />
              </label>
              <label class="toggle-field">
                <div class="toggle-wrap">
                  <input v-model="installForm.enabled" type="checkbox" class="toggle-input" id="tpl-enabled" />
                  <label for="tpl-enabled" class="toggle-track"></label>
                </div>
                <span>启用服务</span>
              </label>
              <label class="toggle-field">
                <div class="toggle-wrap">
                  <input v-model="installForm.auto_connect" type="checkbox" class="toggle-input" id="tpl-auto" />
                  <label for="tpl-auto" class="toggle-track"></label>
                </div>
                <span>自动连接</span>
              </label>
            </div>

            <label class="toggle-field">
              <div class="toggle-wrap">
                <input v-model="installForm.requires_approval" type="checkbox" class="toggle-input" id="tpl-approval" />
                <label for="tpl-approval" class="toggle-track"></label>
              </div>
              <span>需要用户审批（高风险操作保护）</span>
            </label>

            <div class="form-actions">
              <button class="btn-ghost" @click="resetInstallForm">重置</button>
              <button class="btn-primary" :disabled="installing" @click="installSelectedTemplate">
                <svg v-if="!installing" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <div v-else class="spinner spinner--sm spinner--inline"></div>
                {{ installing ? '安装中...' : '安装服务' }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </section>

    <!-- ── Tab: Registry 搜索 ────────────────────────────── -->
    <section v-if="activeTab === 'registry'" class="tab-content">
      <div class="section-toolbar">
        <div class="toolbar-left">
          <h2 class="section-title">MCP Registry</h2>
          <p class="section-desc">搜索官方 Registry，按可用安装方式一键导入。</p>
        </div>
      </div>

      <!-- 搜索栏 -->
      <div class="registry-search-bar glass-card">
        <div class="search-input-wrap">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            v-model.trim="registrySearch.query"
            type="text"
            placeholder="搜索服务名称，如 github / filesystem / mysql ..."
            class="registry-search-input"
            @keyup.enter="searchRegistryServers"
          />
        </div>
        <label class="toggle-field toggle-field--inline">
          <div class="toggle-wrap">
            <input v-model="registrySearch.latest_only" type="checkbox" class="toggle-input" id="reg-latest" />
            <label for="reg-latest" class="toggle-track"></label>
          </div>
          <span>仅最新版本</span>
        </label>
        <button class="btn-action" :disabled="loadingRegistryResults" @click="searchRegistryServers">
          {{ loadingRegistryResults ? '搜索中...' : '搜索' }}
        </button>
      </div>

      <div v-if="loadingRegistryResults" class="state-panel">
        <div class="spinner"></div>
        <p>正在搜索 Registry...</p>
      </div>
      <div v-else-if="!registryResults.length" class="state-panel state-panel--empty">
        <div class="empty-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <p class="empty-title">暂无搜索结果</p>
        <p class="empty-hint">尝试输入关键词后点击搜索</p>
      </div>
      <div v-else class="registry-grid">
        <article v-for="item in registryResults" :key="`${item.name}-${item.version}`" class="registry-card glass-card">
          <div class="registry-card-head">
            <div class="registry-card-title">
              <h3>{{ item.display_name || item.name }}</h3>
              <div class="registry-card-meta">
                <code>{{ item.name }}</code>
                <span class="version-tag">v{{ item.version }}</span>
                <span v-if="item.latest" class="badge badge-success">Latest</span>
              </div>
            </div>
          </div>

          <p class="registry-desc">{{ item.description || '暂无描述' }}</p>

          <div v-if="item.install_options?.length" class="install-options-row">
            <span
              v-for="option in item.install_options"
              :key="option.id"
              class="option-chip"
              :class="option.supported ? 'option-chip--ok' : 'option-chip--no'"
              :title="option.supported ? option.label : option.unsupported_reason"
            >
              <svg v-if="option.supported" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <svg v-else xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              {{ option.label }}
            </span>
          </div>

          <div v-if="firstUnsupportedReason(item)" class="inline-warning">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            {{ firstUnsupportedReason(item) }}
          </div>

          <div class="registry-card-actions">
            <button class="btn-accent btn-sm" :disabled="!item.installable || installingRegistry" @click="handleRegistryInstall(item)">
              {{ quickInstallButtonText(item) }}
            </button>
            <button class="btn-secondary btn-sm" :disabled="!item.install_options?.length" @click="openRegistryInstallDialog(item)">
              配置安装
            </button>
            <div class="registry-links">
              <a v-if="item.website_url" class="ext-link" @click.prevent="openExternalLink(item.website_url)" href="#">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                </svg>
                官网
              </a>
              <a v-if="item.repository_url" class="ext-link" @click.prevent="openExternalLink(item.repository_url)" href="#">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
                </svg>
                源码
              </a>
            </div>
          </div>
        </article>
      </div>

      <div v-if="registryNextCursor" class="load-more-row">
        <button class="btn-secondary" :disabled="loadingMoreRegistry" @click="loadMoreRegistryServers">
          {{ loadingMoreRegistry ? '加载中...' : '加载更多结果' }}
        </button>
      </div>
    </section>

    <!-- ════════════════════════════════════════════════════════
         模态：Registry 配置安装
         ════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="registryInstallDialogVisible" class="modal-backdrop" @click.self="closeRegistryInstallDialog">
        <div class="modal-shell glass-card">
          <div class="modal-header">
            <div class="modal-title-block">
              <h3>配置安装</h3>
              <p>{{ selectedRegistryServer?.display_name || selectedRegistryServer?.name }}</p>
            </div>
            <button class="modal-close-btn" @click="closeRegistryInstallDialog" aria-label="关闭">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="modal-body">
            <div class="form-grid">
              <label class="field">
                <span>安装方式</span>
                <CustomSelect
                  :model-value="registryInstallForm.option_id"
                  :options="[{ value: '', label: '请选择安装方式' }, ...(selectedRegistryServer?.install_options || []).map(o => ({ value: o.id, label: o.supported ? o.label : `${o.label}（暂不支持）`, disabled: !o.supported }))]"
                  placeholder="请选择安装方式"
                  @update:model-value="registryInstallForm.option_id = $event; handleRegistryOptionChange($event)"
                />
                <small v-if="selectedRegistryOption?.command_preview">命令：{{ selectedRegistryOption.command_preview }}</small>
                <small v-if="selectedRegistryOption?.url_preview">地址：{{ selectedRegistryOption.url_preview }}</small>
                <small v-if="selectedRegistryOption?.unsupported_reason" class="text-warning">{{ selectedRegistryOption.unsupported_reason }}</small>
              </label>
            </div>

            <div class="form-grid two-col">
              <label class="field">
                <span>服务名称</span>
                <input v-model.trim="registryInstallForm.server_name" type="text" placeholder="本地唯一标识" />
              </label>
              <label class="field">
                <span>显示名称</span>
                <input v-model.trim="registryInstallForm.display_name" type="text" placeholder="页面展示名称" />
              </label>
            </div>

            <div v-if="selectedRegistryFields.length" class="form-grid two-col">
              <label v-for="field in selectedRegistryFields" :key="field.key" class="field">
                <span>{{ field.label }}<em v-if="field.required">*</em></span>
                <input
                  v-if="field.format !== 'boolean'"
                  v-model="registryInstallForm.input_values[field.key]"
                  :type="field.secret ? 'password' : field.format === 'number' ? 'number' : 'text'"
                  :placeholder="field.placeholder || ''"
                />
                <label v-else class="toggle-field toggle-field--inner">
                  <div class="toggle-wrap">
                    <input v-model="registryInstallForm.input_values[field.key]" type="checkbox" class="toggle-input" :id="`rf-${field.key}`" />
                    <label :for="`rf-${field.key}`" class="toggle-track"></label>
                  </div>
                  <span>启用</span>
                </label>
                <small v-if="field.description">{{ field.description }}</small>
                <small v-if="field.repeated">多值请用英文逗号分隔</small>
              </label>
            </div>

            <div class="form-divider"></div>
            <div class="form-grid four-col">
              <label class="field">
                <span>超时秒数</span>
                <NumberInput :model-value="registryInstallForm.timeout" :min="1" :max="300" @update:model-value="registryInstallForm.timeout = $event" />
              </label>
              <label class="field">
                <span>风险等级</span>
                <CustomSelect
                  :model-value="registryInstallForm.risk_level"
                  :options="riskOptions"
                  @update:model-value="registryInstallForm.risk_level = $event"
                />
              </label>
              <label class="toggle-field">
                <div class="toggle-wrap">
                  <input v-model="registryInstallForm.enabled" type="checkbox" class="toggle-input" id="ri-enabled" />
                  <label for="ri-enabled" class="toggle-track"></label>
                </div>
                <span>启用服务</span>
              </label>
              <label class="toggle-field">
                <div class="toggle-wrap">
                  <input v-model="registryInstallForm.auto_connect" type="checkbox" class="toggle-input" id="ri-auto" />
                  <label for="ri-auto" class="toggle-track"></label>
                </div>
                <span>自动连接</span>
              </label>
            </div>
            <label class="toggle-field">
              <div class="toggle-wrap">
                <input v-model="registryInstallForm.requires_approval" type="checkbox" class="toggle-input" id="ri-approval" />
                <label for="ri-approval" class="toggle-track"></label>
              </div>
              <span>需要审批</span>
            </label>
          </div>

          <div class="modal-footer">
            <button class="btn-ghost" @click="closeRegistryInstallDialog">取消</button>
            <button class="btn-primary" :disabled="installingRegistry || !selectedRegistryOption?.supported" @click="submitRegistryInstall()">
              <div v-if="installingRegistry" class="spinner spinner--sm spinner--inline"></div>
              {{ installingRegistry ? '安装中...' : '安装服务' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════
         模态：编辑 MCP 服务
         ════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="editDialogVisible && editForm" class="modal-backdrop" @click.self="closeEditDialog">
        <div class="modal-shell glass-card">
          <div class="modal-header">
            <div class="modal-title-block">
              <h3>编辑 MCP 服务</h3>
              <p class="font-mono">{{ editForm.name }}</p>
            </div>
            <button class="modal-close-btn" @click="closeEditDialog" aria-label="关闭">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="modal-body">
            <div class="form-grid two-col">
              <label class="field">
                <span>显示名称</span>
                <input v-model="editForm.display_name" type="text" />
              </label>
              <label class="field">
                <span>传输方式</span>
                <CustomSelect
                  :model-value="editForm.transport"
                  :options="transportOptions"
                  @update:model-value="editForm.transport = $event"
                />
              </label>
            </div>

            <div v-if="editForm.transport === 'stdio'" class="form-grid">
              <label class="field">
                <span>命令</span>
                <input v-model="editForm.command" type="text" placeholder="如 npx / node / python" />
              </label>
              <label class="field">
                <span>参数列表 (JSON Array)</span>
                <textarea v-model="editForm.argsJson" rows="4" class="font-mono-input"></textarea>
              </label>
              <label class="field">
                <span>环境变量 (JSON Object)</span>
                <textarea v-model="editForm.envJson" rows="4" class="font-mono-input"></textarea>
              </label>
            </div>

            <div v-else class="form-grid">
              <label class="field">
                <span>URL</span>
                <input v-model="editForm.url" type="url" placeholder="http://localhost:8080/mcp" />
              </label>
              <label class="field">
                <span>Headers (JSON Object)</span>
                <textarea v-model="editForm.headersJson" rows="4" class="font-mono-input"></textarea>
              </label>
            </div>

            <div class="form-divider"></div>
            <div class="form-grid four-col">
              <label class="field">
                <span>超时秒数</span>
                <NumberInput :model-value="editForm.timeout" :min="1" :max="300" @update:model-value="editForm.timeout = $event" />
              </label>
              <label class="field">
                <span>风险等级</span>
                <CustomSelect
                  :model-value="editForm.risk_level"
                  :options="riskOptions"
                  @update:model-value="editForm.risk_level = $event"
                />
              </label>
              <label class="toggle-field">
                <div class="toggle-wrap">
                  <input v-model="editForm.enabled" type="checkbox" class="toggle-input" id="ed-enabled" />
                  <label for="ed-enabled" class="toggle-track"></label>
                </div>
                <span>启用服务</span>
              </label>
              <label class="toggle-field">
                <div class="toggle-wrap">
                  <input v-model="editForm.auto_connect" type="checkbox" class="toggle-input" id="ed-auto" />
                  <label for="ed-auto" class="toggle-track"></label>
                </div>
                <span>自动连接</span>
              </label>
            </div>
            <label class="toggle-field">
              <div class="toggle-wrap">
                <input v-model="editForm.requires_approval" type="checkbox" class="toggle-input" id="ed-approval" />
                <label for="ed-approval" class="toggle-track"></label>
              </div>
              <span>需要审批</span>
            </label>
          </div>

          <div class="modal-footer">
            <button class="btn-ghost" @click="closeEditDialog">取消</button>
            <button class="btn-primary" :disabled="savingEdit" @click="saveEdit">
              <div v-if="savingEdit" class="spinner spinner--sm spinner--inline"></div>
              {{ savingEdit ? '保存中...' : '保存更改' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ════════════════════════════════════════════════════════
         模态：工具列表
         ════════════════════════════════════════════════════════ -->
    <Teleport to="body">
      <div v-if="toolsDialogVisible" class="modal-backdrop" @click.self="closeToolsDialog">
        <div class="modal-shell modal-shell--narrow glass-card">
          <div class="modal-header">
            <div class="modal-title-block">
              <h3>工具列表</h3>
              <p>{{ activeToolsServerName }}</p>
            </div>
            <button class="modal-close-btn" @click="closeToolsDialog" aria-label="关闭">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <div class="modal-body">
            <div v-if="!serverTools.length" class="state-panel state-panel--empty">
              <p class="empty-title">暂无工具</p>
              <p class="empty-hint">服务未声明任何工具，或连接未成功</p>
            </div>
            <ul v-else class="tool-list">
              <li v-for="tool in serverTools" :key="tool.function?.name || Math.random()" class="tool-item">
                <div class="tool-item-head">
                  <code class="tool-name">{{ tool.function?.name || '-' }}</code>
                </div>
                <p class="tool-desc">{{ tool.function?.description || '暂无描述' }}</p>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </Teleport>

    <AppToast ref="toastRef" />
  </div><!-- /mcp-shell -->
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import AppToast from '../components/AppToast.vue';
import CustomSelect from '../components/CustomSelect.vue';
import NumberInput from '../components/NumberInput.vue';
import {
  connectMCPServer,
  deleteMCPServer,
  disconnectMCPServer,
  getMCPServerTools,
  installMCPRegistryServer,
  installMCPServerFromTemplate,
  listMCPRegistryServers,
  listMCPServers,
  listMCPTemplates,
  testMCPServer,
  updateMCPServer,
} from '../api/mcpService';

const emit = defineEmits(['navigate']);

// ── Refs ─────────────────────────────────────────────────
const toastRef = ref(null);
const activeTab = ref('installed');
const templateFilter = ref('');

const loadingTemplates = ref(false);
const loadingServers = ref(false);
const loadingRegistryResults = ref(false);
const loadingMoreRegistry = ref(false);
const installing = ref(false);
const installingRegistry = ref(false);
const savingEdit = ref(false);

const templates = ref([]);
const servers = ref([]);
const registryResults = ref([]);
const registryNextCursor = ref('');
const serverTools = ref([]);
const activeToolsServerName = ref('');
const selectedRegistryServer = ref(null);
const registryInstallDialogVisible = ref(false);
const editDialogVisible = ref(false);
const toolsDialogVisible = ref(false);
const editForm = ref(null);

// ── 静态选项 ──────────────────────────────────────────────
const riskOptions = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const transportOptions = [
  { value: 'stdio', label: 'stdio（本地进程）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
  { value: 'streamable_http', label: 'Streamable HTTP' },
];

// ── Tab 定义 ──────────────────────────────────────────────
const tabs = computed(() => [
  {
    id: 'installed',
    label: '已安装服务',
    badge: servers.value.length || null,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>`,
  },
  {
    id: 'template',
    label: '模板安装',
    badge: null,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>`,
  },
  {
    id: 'registry',
    label: 'Registry',
    badge: null,
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>`,
  },
]);

// ── Forms ─────────────────────────────────────────────────
const installForm = reactive({
  template_id: '',
  server_name: '',
  display_name: '',
  enabled: true,
  auto_connect: true,
  timeout: 30,
  risk_level: 'medium',
  requires_approval: false,
  options: {},
});

const registrySearch = reactive({
  query: '',
  latest_only: true,
  limit: 6,
});

const registryInstallForm = reactive({
  option_id: '',
  server_name: '',
  display_name: '',
  enabled: true,
  auto_connect: true,
  timeout: 30,
  risk_level: 'medium',
  requires_approval: false,
  input_values: {},
});

// ── Computed ──────────────────────────────────────────────
const selectedTemplate = computed(() => templates.value.find((t) => t.id === installForm.template_id) || null);
const filteredTemplates = computed(() => {
  const q = templateFilter.value.trim().toLowerCase();
  if (!q) return templates.value;
  return templates.value.filter((t) =>
    (t.display_name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
  );
});
const selectedRegistryOption = computed(() =>
  selectedRegistryServer.value?.install_options?.find((o) => o.id === registryInstallForm.option_id) || null
);
const selectedRegistryFields = computed(() => selectedRegistryOption.value?.form_fields || []);
const summary = computed(() => ({
  total: servers.value.length,
  connected: servers.value.filter((s) => s.status === 'connected').length,
  enabled: servers.value.filter((s) => s.enabled).length,
  tools: servers.value.reduce((sum, s) => sum + (s.tool_count || 0), 0),
}));

// ── Helpers ───────────────────────────────────────────────
function showToast(message, type = 'error') {
  toastRef.value?.show(message, type);
}

function openExternalLink(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function statusBadgeClass(status) {
  if (status === 'connected') return 'badge-success';
  if (status === 'connecting') return 'badge-warning';
  if (status === 'error') return 'badge-error';
  return 'badge-neutral';
}

function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return '';
  return args.join(' ');
}

function formatHeaders(headers) {
  const keys = Object.keys(headers || {});
  return keys.length ? `Headers: ${keys.join(', ')}` : '远程服务地址';
}

function applyTemplateDefaults(template) {
  installForm.server_name = template?.recommended_server_name || '';
  installForm.display_name = template?.defaults?.display_name || template?.display_name || '';
  installForm.enabled = template?.defaults?.enabled ?? true;
  installForm.auto_connect = template?.defaults?.auto_connect ?? true;
  installForm.timeout = template?.defaults?.timeout ?? 30;
  installForm.risk_level = template?.defaults?.risk_level || 'medium';
  installForm.requires_approval = template?.defaults?.requires_approval ?? false;
  installForm.options = {};
  (template?.fields || []).forEach((f) => { installForm.options[f.name] = f.default ?? ''; });
}

function handleTemplateChange(id) {
  installForm.template_id = id;
  const tmpl = templates.value.find((t) => t.id === id);
  if (tmpl) applyTemplateDefaults(tmpl);
}

function resetInstallForm() {
  if (selectedTemplate.value) { applyTemplateDefaults(selectedTemplate.value); return; }
  installForm.template_id = '';
  installForm.server_name = '';
  installForm.display_name = '';
  installForm.enabled = true;
  installForm.auto_connect = true;
  installForm.timeout = 30;
  installForm.risk_level = 'medium';
  installForm.requires_approval = false;
  installForm.options = {};
}

function defaultFieldValue(field) {
  if (field.default_value !== null && field.default_value !== undefined) return field.default_value;
  if (field.format === 'boolean') return false;
  return '';
}

function initializeRegistryInputValues(option) {
  const values = {};
  (option?.form_fields || []).forEach((f) => { values[f.key] = defaultFieldValue(f); });
  registryInstallForm.input_values = values;
}

function getPreferredInstallOption(server) {
  return server?.install_options?.find((o) => o.id === server.preferred_option_id)
    || server?.install_options?.find((o) => o.supported)
    || server?.install_options?.[0]
    || null;
}

function countSupportedInstallOptions(server) {
  return (server?.install_options || []).filter((o) => o.supported).length;
}

function canQuickInstall(server) {
  const option = getPreferredInstallOption(server);
  if (!option?.supported) return false;
  if (countSupportedInstallOptions(server) !== 1) return false;
  return !(option.form_fields || []).some((f) => {
    if (!f.required) return false;
    const v = f.default_value;
    return v === null || v === undefined || v === '';
  });
}

function quickInstallButtonText(server) {
  return canQuickInstall(server) ? '一键安装' : '安装';
}

function firstUnsupportedReason(server) {
  return server?.install_options?.find((o) => !o.supported)?.unsupported_reason || '';
}

function applyRegistryInstallDefaults(server, option) {
  registryInstallForm.option_id = option?.id || '';
  registryInstallForm.server_name = option?.default_server_name || server?.default_server_name || '';
  registryInstallForm.display_name = option?.default_display_name || server?.default_display_name || server?.display_name || '';
  registryInstallForm.enabled = true;
  registryInstallForm.auto_connect = true;
  registryInstallForm.timeout = option?.default_timeout || 30;
  registryInstallForm.risk_level = option?.default_risk_level || 'medium';
  registryInstallForm.requires_approval = option?.default_requires_approval ?? false;
  initializeRegistryInputValues(option);
}

function openRegistryInstallDialog(server) {
  selectedRegistryServer.value = server;
  applyRegistryInstallDefaults(server, getPreferredInstallOption(server));
  registryInstallDialogVisible.value = true;
}

function closeRegistryInstallDialog() { registryInstallDialogVisible.value = false; }

function handleRegistryOptionChange(optionId) {
  const option = selectedRegistryServer.value?.install_options?.find((o) => o.id === optionId);
  if (!option) return;
  registryInstallForm.timeout = option.default_timeout || registryInstallForm.timeout;
  registryInstallForm.risk_level = option.default_risk_level || registryInstallForm.risk_level;
  registryInstallForm.requires_approval = option.default_requires_approval ?? registryInstallForm.requires_approval;
  initializeRegistryInputValues(option);
}

function openEditDialog(server) {
  editForm.value = {
    name: server.name,
    display_name: server.display_name || '',
    transport: server.transport || 'stdio',
    command: server.command || '',
    argsJson: JSON.stringify(server.args || [], null, 2),
    envJson: JSON.stringify(server.env || {}, null, 2),
    headersJson: JSON.stringify(server.headers || {}, null, 2),
    url: server.url || '',
    enabled: !!server.enabled,
    auto_connect: !!server.auto_connect,
    timeout: server.timeout || 30,
    risk_level: server.risk_level || 'medium',
    requires_approval: !!server.requires_approval,
  };
  editDialogVisible.value = true;
}

function closeEditDialog() { editDialogVisible.value = false; editForm.value = null; }
function closeToolsDialog() { toolsDialogVisible.value = false; }

// ── API 调用 ──────────────────────────────────────────────
async function loadTemplates() {
  loadingTemplates.value = true;
  try {
    const res = await listMCPTemplates();
    templates.value = res.data || [];
    if (!installForm.template_id && templates.value.length > 0) {
      installForm.template_id = templates.value[0].id;
      applyTemplateDefaults(templates.value[0]);
    }
  } catch (error) {
    showToast(error.message || '加载模板失败');
  } finally {
    loadingTemplates.value = false;
  }
}

async function loadServers() {
  loadingServers.value = true;
  try {
    const res = await listMCPServers();
    servers.value = res.data || [];
  } catch (error) {
    showToast(error.message || '加载服务失败');
  } finally {
    loadingServers.value = false;
  }
}

async function refreshAll() {
  await Promise.all([loadTemplates(), loadServers()]);
}

async function searchRegistryServers({ append = false } = {}) {
  if (append && !registryNextCursor.value) return;
  const loadingRef = append ? loadingMoreRegistry : loadingRegistryResults;
  loadingRef.value = true;
  try {
    const res = await listMCPRegistryServers({
      search: registrySearch.query,
      limit: registrySearch.limit,
      cursor: append ? registryNextCursor.value : '',
      latest_only: registrySearch.latest_only,
    });
    const items = res.data?.items || [];
    registryResults.value = append ? [...registryResults.value, ...items] : items;
    registryNextCursor.value = res.data?.next_cursor || '';
  } catch (error) {
    showToast(error.message || '搜索 Registry 失败');
  } finally {
    loadingRef.value = false;
  }
}

async function loadMoreRegistryServers() { await searchRegistryServers({ append: true }); }

async function installSelectedTemplate() {
  if (!installForm.template_id) { showToast('请先选择一个模板', 'warning'); return; }
  const missingField = (selectedTemplate.value?.fields || []).find(
    (f) => f.required && !String(installForm.options[f.name] ?? '').trim()
  );
  if (missingField) { showToast(`请填写 ${missingField.label}`, 'warning'); return; }
  installing.value = true;
  try {
    const res = await installMCPServerFromTemplate({
      template_id: installForm.template_id,
      server_name: installForm.server_name,
      display_name: installForm.display_name,
      enabled: installForm.enabled,
      auto_connect: installForm.auto_connect,
      timeout: installForm.timeout,
      risk_level: installForm.risk_level,
      requires_approval: installForm.requires_approval,
      options: installForm.options,
    });
    showToast(res.message || '安装成功', 'success');
    await loadServers();
    activeTab.value = 'installed';
  } catch (error) {
    showToast(error.message || '安装失败');
  } finally {
    installing.value = false;
  }
}

async function submitRegistryInstall(customPayload = null) {
  const option = selectedRegistryOption.value || customPayload?.install_option;
  if (!option) { showToast('请选择一个可用的安装方式', 'warning'); return; }
  if (!option.supported) { showToast(option.unsupported_reason || '当前安装方式暂不支持', 'warning'); return; }
  const payload = customPayload || {
    install_option: option,
    server_name: registryInstallForm.server_name,
    display_name: registryInstallForm.display_name,
    enabled: registryInstallForm.enabled,
    auto_connect: registryInstallForm.auto_connect,
    timeout: registryInstallForm.timeout,
    risk_level: registryInstallForm.risk_level,
    requires_approval: registryInstallForm.requires_approval,
    input_values: registryInstallForm.input_values,
  };
  const missingField = (option.form_fields || []).find(
    (f) => f.required && (payload.input_values?.[f.key] === '' || payload.input_values?.[f.key] == null)
  );
  if (missingField) { showToast(`请填写 ${missingField.label}`, 'warning'); return; }
  installingRegistry.value = true;
  try {
    const res = await installMCPRegistryServer(payload);
    showToast(res.message || '安装成功', 'success');
    closeRegistryInstallDialog();
    await loadServers();
    activeTab.value = 'installed';
  } catch (error) {
    showToast(error.message || 'Registry 安装失败');
  } finally {
    installingRegistry.value = false;
  }
}

async function handleRegistryInstall(server) {
  const option = getPreferredInstallOption(server);
  if (!option?.supported) { showToast(firstUnsupportedReason(server) || '当前没有可用安装方式', 'warning'); return; }
  if (!canQuickInstall(server)) { openRegistryInstallDialog(server); return; }
  const payload = {
    install_option: option,
    server_name: option.default_server_name || server.default_server_name,
    display_name: option.default_display_name || server.default_display_name,
    enabled: true,
    auto_connect: true,
    timeout: option.default_timeout || 30,
    risk_level: option.default_risk_level || 'medium',
    requires_approval: option.default_requires_approval ?? false,
    input_values: Object.fromEntries((option.form_fields || []).map((f) => [f.key, defaultFieldValue(f)])),
  };
  await submitRegistryInstall(payload);
}

async function saveEdit() {
  if (!editForm.value) return;
  savingEdit.value = true;
  try {
    let parsedArgs = [], parsedEnv = {}, parsedHeaders = {};
    if (editForm.value.transport === 'stdio') {
      parsedArgs = JSON.parse(editForm.value.argsJson || '[]');
      parsedEnv = JSON.parse(editForm.value.envJson || '{}');
    } else {
      parsedHeaders = JSON.parse(editForm.value.headersJson || '{}');
    }
    const res = await updateMCPServer(editForm.value.name, {
      display_name: editForm.value.display_name,
      transport: editForm.value.transport,
      enabled: editForm.value.enabled,
      auto_connect: editForm.value.auto_connect,
      timeout: editForm.value.timeout,
      risk_level: editForm.value.risk_level,
      requires_approval: editForm.value.requires_approval,
      command: editForm.value.transport === 'stdio' ? editForm.value.command : null,
      args: editForm.value.transport === 'stdio' ? parsedArgs : [],
      env: editForm.value.transport === 'stdio' ? parsedEnv : {},
      headers: editForm.value.transport === 'stdio' ? {} : parsedHeaders,
      url: editForm.value.transport === 'stdio' ? null : editForm.value.url,
    });
    showToast(res.message || '保存成功', 'success');
    closeEditDialog();
    await loadServers();
  } catch (error) {
    showToast(error.message || '保存失败');
  } finally {
    savingEdit.value = false;
  }
}

async function handleConnect(server) {
  try {
    const res = await connectMCPServer(server.name);
    showToast(res.message || '连接成功', 'success');
    await loadServers();
  } catch (error) {
    showToast(error.message || '连接失败');
  }
}

async function handleDisconnect(server) {
  try {
    const res = await disconnectMCPServer(server.name);
    showToast(res.message || '断开成功', 'success');
    await loadServers();
  } catch (error) {
    showToast(error.message || '断开失败');
  }
}

async function handleTest(server) {
  try {
    const res = await testMCPServer(server.name);
    showToast(res.message || '测试成功', 'success');
    await loadServers();
  } catch (error) {
    showToast(error.message || '测试失败');
  }
}

async function showTools(server) {
  try {
    const res = await getMCPServerTools(server.name);
    serverTools.value = res.data?.tools || [];
    activeToolsServerName.value = server.display_name || server.name;
    toolsDialogVisible.value = true;
  } catch (error) {
    showToast(error.message || '加载工具失败');
  }
}

async function handleDelete(server) {
  if (!window.confirm(`确定删除 MCP 服务"${server.display_name || server.name}"吗？`)) return;
  try {
    const res = await deleteMCPServer(server.name);
    showToast(res.message || '删除成功', 'success');
    await loadServers();
  } catch (error) {
    showToast(error.message || '删除失败');
  }
}

onMounted(async () => {
  await loadTemplates();
  await loadServers();
  await searchRegistryServers();
});
</script>

<style scoped>
/* ─── 页面容器 ──────────────────────────────────────────── */
.mcp-page {
  height: 100%;
  overflow: auto;
  padding: var(--spacing-xl);
  background: var(--color-bg-app);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.mcp-shell {
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

/* ─── Header ────────────────────────────────────────────── */
.mcp-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--spacing-lg);
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
}

.btn-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  height: 40px;
  padding: 0 16px;
  border-radius: 20px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--transition-fast);
  user-select: none;
}
.btn-back:hover {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
}
.btn-back:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.header-actions { display: flex; align-items: center; gap: var(--spacing-sm); }

.header-meta { display: flex; flex-direction: column; gap: 2px; }
.page-title { font-size: var(--font-size-xl); font-weight: 700; margin: 0; color: var(--color-text-primary); }
.page-subtitle { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }

/* ─── 统计卡片 ──────────────────────────────────────────── */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--spacing-md);
}

.summary-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md) var(--spacing-lg);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: border-color var(--transition-fast);
}
.summary-card:hover { border-color: rgba(var(--color-brand-accent-rgb), 0.35); }

.summary-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}
.summary-icon--total   { background: rgba(var(--color-brand-accent-rgb), 0.1); color: var(--color-brand-accent-light); border-color: rgba(var(--color-brand-accent-rgb), 0.2); }
.summary-icon--connected { background: rgba(var(--color-success-rgb), 0.1); color: var(--color-success); border-color: rgba(var(--color-success-rgb), 0.2); }
.summary-icon--enabled { background: rgba(var(--color-active-rgb), 0.1); color: var(--color-active); border-color: rgba(var(--color-active-rgb), 0.2); }
.summary-icon--tools   { background: rgba(var(--color-warning-rgb), 0.1);  color: var(--color-warning); border-color: rgba(var(--color-warning-rgb), 0.2); }

.summary-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.summary-label { color: var(--color-text-secondary); font-size: var(--font-size-xs); white-space: nowrap; }
.summary-value { display: block; font-size: var(--font-size-2xl); font-weight: 700; line-height: 1.2; color: var(--color-text-primary); }
.summary-value--connected { color: var(--color-success); }
.summary-value--enabled   { color: var(--color-active); }
.summary-value--tools     { color: var(--color-warning); }

/* ─── Tab 导航 ──────────────────────────────────────────── */
.tab-nav {
  display: flex;
  gap: 2px;
  padding: 4px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  width: fit-content;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 8px 18px;
  border-radius: var(--radius-md);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}
.tab-btn:hover { color: var(--color-text-primary); background: var(--color-hover-overlay); }
.tab-btn--active {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  font-weight: 500;
  box-shadow: var(--shadow-sm);
}

.tab-icon { display: flex; align-items: center; }
.tab-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-full);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}
.tab-btn--active .tab-badge { background: rgba(var(--color-brand-accent-rgb), 0.2); color: var(--color-brand-accent-light); }

/* ─── Tab 内容区 ────────────────────────────────────────── */
.tab-content { display: flex; flex-direction: column; gap: var(--spacing-lg); }

.section-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--spacing-md);
}
.toolbar-left { display: flex; flex-direction: column; gap: 2px; }
.section-title { font-size: var(--font-size-lg); font-weight: 600; margin: 0; color: var(--color-text-primary); }
.section-desc { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }

/* ─── 按钮系统 ──────────────────────────────────────────── */
.btn-action,
.btn-secondary,
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 9px 16px;
  border-radius: 20px;
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.btn-action {
  height: 40px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.btn-action:hover:not(:disabled) { background: var(--color-interactive-hover); border-color: var(--color-border-hover); }

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  height: 44px;
  padding: 0 24px;
  border-radius: 22px;
  border: none;
  background: linear-gradient(135deg,
    rgba(var(--color-brand-accent-rgb), 0.9) 0%,
    rgba(var(--color-brand-accent-light-rgb), 0.95) 100%);
  color: #fff;
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.01em;
  cursor: pointer;
  white-space: nowrap;
  box-shadow:
    0 4px 12px rgba(var(--color-brand-accent-rgb), 0.35),
    0 1px 3px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow:
    0 6px 20px rgba(var(--color-brand-accent-rgb), 0.45),
    0 2px 4px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.btn-primary:active:not(:disabled) {
  transform: translateY(0);
  box-shadow:
    0 2px 8px rgba(var(--color-brand-accent-rgb), 0.35),
    0 1px 2px rgba(0, 0, 0, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
}
.btn-primary:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-secondary {
  height: 40px;
  border: 1px solid var(--color-border);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font-weight: 500;
}
.btn-secondary:hover:not(:disabled) { background: var(--color-interactive-hover); border-color: var(--color-border-hover); }
.btn-secondary:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-ghost {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
}
.btn-ghost:hover { color: var(--color-text-primary); background: var(--color-hover-overlay); }

/* 轻量强调按钮（卡片内操作，无发光） */
.btn-accent {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  height: 36px;
  padding: 0 16px;
  border-radius: 18px;
  border: 1px solid rgba(var(--color-brand-accent-rgb), 0.4);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  color: var(--color-brand-accent-light);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--transition-fast);
}
.btn-accent:hover:not(:disabled) {
  background: rgba(var(--color-brand-accent-rgb), 0.22);
  border-color: rgba(var(--color-brand-accent-rgb), 0.6);
}
.btn-accent:disabled { opacity: 0.45; cursor: not-allowed; }

.btn-sm { height: 36px !important; padding: 0 14px; font-size: var(--font-size-xs); border-radius: 18px; }

.btn-action:disabled { opacity: 0.45; cursor: not-allowed; }

/* ─── State panel ───────────────────────────────────────── */
.state-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-2xl) var(--spacing-lg);
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.empty-icon { color: var(--color-text-muted); margin-bottom: var(--spacing-xs); }
.empty-title { font-size: var(--font-size-base); color: var(--color-text-primary); font-weight: 500; margin: 0; }
.empty-hint  { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }

/* ─── Spinner ───────────────────────────────────────────── */
.spinner {
  width: 28px; height: 28px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-brand-accent-light);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.spinner--sm { width: 16px; height: 16px; border-width: 2px; }
.spinner--inline { flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── 已安装服务卡片网格 ────────────────────────────────── */
.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: var(--spacing-lg);
}

.server-card {
  border-radius: var(--radius-xl);
  padding: var(--spacing-lg);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.server-card:hover {
  border-color: rgba(var(--color-brand-accent-rgb), 0.35);
  box-shadow: var(--shadow-lg);
}

.server-card-head {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
}

.server-card-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  border: 1px solid var(--color-border);
}
.server-icon--stdio { background: rgba(99, 102, 241, 0.12); color: var(--color-brand-accent-light); }
.server-icon--sse   { background: rgba(52, 211, 153, 0.12); color: var(--color-success); }
.server-icon--streamable_http { background: rgba(96, 165, 250, 0.12); color: var(--color-active); }

.server-card-info { flex: 1; min-width: 0; }
.server-card-name { font-weight: 600; font-size: var(--font-size-base); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.server-card-id   { color: var(--color-text-muted); font-size: var(--font-size-xs); font-family: var(--font-mono); margin-top: 2px; }

.server-card-badges { display: flex; align-items: center; gap: var(--spacing-xs); flex-shrink: 0; }

/* 状态点 */
.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot--connected  { background: var(--color-success); box-shadow: 0 0 6px rgba(52, 211, 153, 0.6); }
.status-dot--connecting { background: var(--color-warning); animation: pulse-dot 1s ease-in-out infinite; }
.status-dot--error      { background: var(--color-error); }
.status-dot--unknown    { background: var(--color-text-muted); }
@keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* 元数据行 */
.server-meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-xs);
}
.meta-chip-label { color: var(--color-text-muted); }
.meta-chip-value { color: var(--color-text-primary); font-weight: 500; }
.meta-chip-value--mono { font-family: var(--font-mono); }

.risk--low    { color: var(--color-success); }
.risk--medium { color: var(--color-warning); }
.risk--high   { color: var(--color-error); }
.text-success { color: var(--color-success); }
.text-muted   { color: var(--color-text-muted); }

/* 接入信息 */
.server-connection-info {
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  padding: var(--spacing-sm) var(--spacing-md);
}
.connection-code {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  word-break: break-all;
  display: block;
}

/* 错误横幅 */
.error-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  background: rgba(var(--color-error-rgb), 0.08);
  border: 1px solid rgba(var(--color-error-rgb), 0.2);
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

/* 服务操作按钮 */
.server-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--color-border);
}

.act-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 11px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all var(--transition-fast);
}
.act-btn:hover { color: var(--color-text-primary); border-color: var(--color-border-hover); background: var(--color-hover-overlay); }
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

.act-btn--connect:not(:disabled):hover  { color: var(--color-success); border-color: rgba(var(--color-success-rgb), 0.4); background: rgba(var(--color-success-rgb), 0.08); }
.act-btn--disconnect:not(:disabled):hover { color: var(--color-warning); border-color: rgba(var(--color-warning-rgb), 0.4); background: rgba(var(--color-warning-rgb), 0.08); }
.act-btn--danger { color: var(--color-error); border-color: rgba(var(--color-error-rgb), 0.2); background: rgba(var(--color-error-rgb), 0.06); }
.act-btn--danger:hover { border-color: rgba(var(--color-error-rgb), 0.4); background: rgba(var(--color-error-rgb), 0.12); }

.act-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: rgba(var(--color-brand-accent-rgb), 0.2);
  color: var(--color-brand-accent-light);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

/* ─── 模板安装布局 ──────────────────────────────────────── */
.install-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: var(--spacing-lg);
  min-height: 480px;
}

.template-sidebar {
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.sidebar-search {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-md);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted);
}
.sidebar-search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
}
.sidebar-search-input::placeholder { color: var(--color-text-muted); }

.sidebar-loading { display: flex; align-items: center; justify-content: center; padding: var(--spacing-lg); }

.template-list { flex: 1; overflow: auto; padding: var(--spacing-xs); margin: 0; list-style: none; }
.template-list-empty { padding: var(--spacing-md); color: var(--color-text-muted); font-size: var(--font-size-sm); text-align: center; }

.template-item {
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
  margin-bottom: 2px;
}
.template-item:hover { background: var(--color-hover-overlay); }
.template-item--active { background: var(--color-bg-tertiary); }

.template-item-name { font-size: var(--font-size-sm); font-weight: 500; }
.template-item-desc { font-size: var(--font-size-xs); color: var(--color-text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.template-form {
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.template-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.template-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacing-md);
}
.template-detail-header h3 { font-size: var(--font-size-lg); margin-bottom: 4px; }
.template-detail-header p  { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }

.install-hint-badge {
  flex-shrink: 0;
  padding: 4px 10px;
  border-radius: var(--radius-full);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  border: 1px solid rgba(var(--color-brand-accent-rgb), 0.25);
  color: var(--color-brand-accent-light);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.form-divider {
  height: 1px;
  background: var(--color-border);
  margin: var(--spacing-xs) 0;
}

.form-section-label {
  font-size: var(--font-size-xs);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

/* ─── 表单通用 ──────────────────────────────────────────── */
.form-grid {
  display: grid;
  gap: var(--spacing-md);
}
.form-grid.two-col  { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.form-grid.four-col { grid-template-columns: repeat(4, minmax(0, 1fr)); }

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}
.field > span, .field > label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  letter-spacing: 0.02em;
}
.field em { color: var(--color-error); font-style: normal; margin-left: 3px; }
.field small { color: var(--color-text-muted); font-size: var(--font-size-xs); }

.field input,
.field select,
.field textarea {
  width: 100%;
  height: 42px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  padding: 0 14px;
  font: inherit;
  font-size: var(--font-size-sm);
  transition: border-color var(--transition-fast);
}
.field input:hover,
.field select:hover,
.field textarea:hover {
  border-color: var(--color-border-hover);
}
.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: none;
  border-color: var(--color-border-focus);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}
.field textarea { resize: vertical; min-height: 80px; height: auto; padding: 10px 14px; }

.font-mono-input { font-family: var(--font-mono); font-size: var(--font-size-xs); }

/* Toggle 开关 */
.toggle-field {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  user-select: none;
}
.toggle-field--inline { align-self: flex-end; padding-bottom: 9px; }
.toggle-field--inner  { padding-top: 6px; }

.toggle-wrap { position: relative; }
.toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
.toggle-track {
  display: block;
  width: 36px;
  height: 20px;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  transition: all var(--transition-fast);
  cursor: pointer;
  position: relative;
}
.toggle-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-text-muted);
  transition: all var(--transition-fast);
}
.toggle-input:checked + .toggle-track {
  background: rgba(var(--color-brand-accent-rgb), 0.3);
  border-color: rgba(var(--color-brand-accent-rgb), 0.5);
}
.toggle-input:checked + .toggle-track::after {
  left: 18px;
  background: var(--color-brand-accent-light);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--color-border);
  margin-top: auto;
}

/* ─── Registry 搜索栏 ───────────────────────────────────── */
.registry-search-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
}

.search-input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--color-text-muted);
}
.registry-search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
}
.registry-search-input::placeholder { color: var(--color-text-muted); }

/* Registry 结果卡片网格 */
.registry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--spacing-lg);
}

.registry-card {
  border-radius: var(--radius-xl);
  padding: var(--spacing-lg);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: var(--glass-shadow);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
  transition: border-color var(--transition-fast);
}
.registry-card:hover { border-color: rgba(var(--color-brand-accent-rgb), 0.35); }

.registry-card-head { display: flex; align-items: flex-start; gap: var(--spacing-md); }
.registry-card-title { flex: 1; }
.registry-card-title h3 { font-size: var(--font-size-base); font-weight: 600; margin-bottom: 4px; }
.registry-card-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
.registry-card-meta code { font-family: var(--font-mono); }

.version-tag {
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  color: var(--color-text-secondary);
}

.registry-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.install-options-row { display: flex; flex-wrap: wrap; gap: 6px; }

.option-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  font-size: 11px;
  border: 1px solid transparent;
}
.option-chip--ok {
  background: rgba(var(--color-success-rgb), 0.1);
  border-color: rgba(var(--color-success-rgb), 0.25);
  color: var(--color-success);
}
.option-chip--no {
  background: rgba(var(--color-error-rgb), 0.07);
  border-color: rgba(var(--color-error-rgb), 0.15);
  color: var(--color-text-muted);
}

.inline-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-xs);
  color: var(--color-warning);
  font-size: var(--font-size-xs);
}

.registry-card-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  padding-top: var(--spacing-xs);
  border-top: 1px solid var(--color-border);
  margin-top: auto;
}

.registry-links { display: flex; gap: var(--spacing-xs); margin-left: auto; }
.ext-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-decoration: none;
  border: 1px solid transparent;
  transition: all var(--transition-fast);
  cursor: pointer;
}
.ext-link:hover { color: var(--color-text-primary); border-color: var(--color-border); background: var(--color-hover-overlay); }

.load-more-row { display: flex; justify-content: center; }

/* ─── Badge & Tag ───────────────────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 500;
  border: 1px solid transparent;
}
.badge-success { background: rgba(var(--color-success-rgb), 0.12); color: var(--color-success); border-color: rgba(var(--color-success-rgb), 0.25); }
.badge-warning { background: rgba(var(--color-warning-rgb), 0.12); color: var(--color-warning); border-color: rgba(var(--color-warning-rgb), 0.25); }
.badge-error   { background: rgba(var(--color-error-rgb), 0.12);   color: var(--color-error);   border-color: rgba(var(--color-error-rgb), 0.25); }
.badge-neutral { background: rgba(255,255,255,0.06); color: var(--color-text-secondary); }

.text-warning { color: var(--color-warning); }

/* ─── 模态 ──────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-lg);
}

.modal-shell {
  width: min(860px, 100%);
  max-height: 90vh;
  overflow: auto;
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-glass-border);
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.04);
  display: flex;
  flex-direction: column;
}
.modal-shell--narrow { width: min(560px, 100%); }

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--spacing-md);
  padding: var(--spacing-lg) var(--spacing-lg) 0;
  flex-shrink: 0;
}
.modal-title-block h3 { font-size: var(--font-size-lg); margin-bottom: 2px; }
.modal-title-block p  { color: var(--color-text-secondary); font-size: var(--font-size-sm); }
.font-mono { font-family: var(--font-mono); }

.modal-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}
.modal-close-btn:hover { color: var(--color-text-primary); border-color: var(--color-border-hover); background: var(--color-hover-overlay); }

.modal-body {
  flex: 1;
  overflow: auto;
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* ─── 工具列表 ──────────────────────────────────────────── */
.tool-list { display: flex; flex-direction: column; gap: var(--spacing-sm); list-style: none; margin: 0; padding: 0; }

.tool-item {
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
}
.tool-item-head { margin-bottom: 4px; }
.tool-name {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--color-brand-accent-light);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.tool-desc { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }

/* ─── 响应式 ────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .summary-grid { grid-template-columns: repeat(2, 1fr); }
  .install-layout { grid-template-columns: 1fr; }
  .form-grid.four-col { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 720px) {
  .mcp-page { padding: var(--spacing-md); }
  .mcp-header { flex-direction: column; align-items: flex-start; gap: var(--spacing-sm); }
  .header-actions { width: 100%; justify-content: flex-end; }
  .summary-grid { grid-template-columns: 1fr 1fr; }
  .server-grid  { grid-template-columns: 1fr; }
  .registry-grid { grid-template-columns: 1fr; }
  .form-grid.two-col { grid-template-columns: 1fr; }
  .form-grid.four-col { grid-template-columns: 1fr 1fr; }
  .registry-search-bar { flex-wrap: wrap; }
  .tab-nav { width: 100%; }
}

@media (max-width: 480px) {
  .summary-grid { grid-template-columns: 1fr 1fr;}
  .form-grid.four-col { grid-template-columns: 1fr; }
}
</style>
