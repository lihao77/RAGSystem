<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    mobile-content-padding="var(--spacing-sm)"
    title="MCP 服务管理"
    subtitle="MCP 工具服务接入与测试"
    mobile-title="MCP 服务管理"
  >
    <template #header-actions>
      <Button variant="ghost" size="icon-sm" :disabled="loadingServers" :aria-label="loadingServers ? '刷新中' : '全局刷新'" :title="loadingServers ? '刷新中' : '全局刷新'" @click="refreshAll">
        <IconRefresh :size="16" />
      </Button>
    </template>

    <template #mobile-menu="{ close }">
      <button class="pl-menu-item" :disabled="loadingServers" @click="refreshAll(); close()">
        <IconRefresh :size="16" />
        {{ loadingServers ? '刷新中...' : '全局刷新' }}
      </button>
    </template>

    <KpiCards :items="kpiItems" />

    <EntityListLayout
      title="已安装服务"
      description="管理连接状态、查看工具、修改运行参数。"
      :loading="loadingServers"
      loading-text="正在加载 MCP 服务..."
      :empty="!servers.length"
      empty-title="暂无 MCP 服务"
      empty-hint="点击右上「添加服务」从 Registry 搜索或手动配置。"
      @retry="runLoadServers"
    >
      <template #actions>
        <Button variant="default" @click="openAddService">
          <IconPlus :size="14" />
          <span>添加服务</span>
        </Button>
        <Button variant="secondary" :disabled="loadingServers" @click="runLoadServers">
          <IconRefresh :size="14" />
          <span>刷新</span>
        </Button>
      </template>
      <template #empty-icon>
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </template>

      <div class="server-grid adm-entity-list">
        <article v-for="server in servers" :key="server.name" class="server-card adm-entity-row">
          <div class="server-card__main">
            <div class="server-card-head">
              <div class="server-card-icon" :class="`server-icon--${server.transport || 'stdio'}`">
                <svg v-if="(server.transport || 'stdio') === 'stdio'" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                <svg v-else xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              </div>
              <div class="server-card-info">
                <div class="server-card-name">{{ server.display_name || server.name }}</div>
                <div class="server-card-sub">
                  <code class="server-card-id">{{ server.name }}</code>
                  <code class="server-card-conn">{{ server.transport === 'stdio' ? (server.command ? `${server.command} ${formatArgs(server.args)}` : '无命令') : (server.url || '无地址') }}</code>
                </div>
              </div>
            </div>
            <div class="server-card-badges">
              <span class="status-dot" :class="`status-dot--${server.status || 'unknown'}`" :title="server.status || 'unknown'"></span>
              <UiBadge class="badge" size="sm" :tone="statusBadgeTone(server.status)">{{ server.status || 'unknown' }}</UiBadge>
              <UiBadge v-if="server.trusted === false" class="badge" size="sm" tone="warning" title="未受信任:annotations 不驱动并发,工具保守串行">未信任</UiBadge>
            </div>
          </div>

          <div class="server-meta-row">
            <div class="meta-chip"><span class="meta-chip-label">传输</span><span class="meta-chip-value meta-chip-value--mono">{{ server.transport || 'stdio' }}</span></div>
            <div class="meta-chip"><span class="meta-chip-label">工具</span><span class="meta-chip-value">{{ server.tool_count || 0 }}</span></div>
            <div v-if="server.capability_faces?.resources" class="meta-chip"><span class="meta-chip-label">资源</span><span class="meta-chip-value">{{ server.resource_count || 0 }}</span></div>
            <div v-if="server.capability_faces?.prompts" class="meta-chip"><span class="meta-chip-label">提示词</span><span class="meta-chip-value">{{ server.prompt_count || 0 }}</span></div>
            <div class="meta-chip"><span class="meta-chip-label">风险</span><span class="meta-chip-value" :class="`risk--${server.risk_level || 'medium'}`">{{ server.risk_level || 'medium' }}</span></div>
            <div class="meta-chip"><span class="meta-chip-label">状态</span><span class="meta-chip-value" :class="server.enabled ? 'text-success' : 'text-muted'">{{ server.enabled ? '已启用' : '已禁用' }}</span></div>
          </div>

          <div v-if="server.error_message" class="error-banner">
            <IconInfo :size="14" />
            {{ server.error_message }}
          </div>

          <div class="server-actions">
            <Button variant="action-success" size="action" :disabled="!server.enabled || server.status === 'connected'" @click="handleConnect(server)" title="连接">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>连接
            </Button>
            <Button variant="action-warning" size="action" :disabled="server.status !== 'connected'" @click="handleDisconnect(server)" title="断开">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>断开
            </Button>
            <Button variant="action-neutral" size="action" @click="handleTest(server)" title="测试连接">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>测试
            </Button>
            <Button variant="action-neutral" size="action" @click="showTools(server)" title="查看工具">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>工具 <span v-if="server.tool_count" class="adm-action-badge">{{ server.tool_count }}</span>
            </Button>
            <Button v-if="server.capability_faces?.resources" variant="action-neutral" size="action" @click="showResources(server)" title="查看资源">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/></svg>资源 <span v-if="server.resource_count" class="adm-action-badge">{{ server.resource_count }}</span>
            </Button>
            <Button v-if="server.capability_faces?.prompts" variant="action-neutral" size="action" @click="showPrompts(server)" title="查看提示词">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>提示词 <span v-if="server.prompt_count" class="adm-action-badge">{{ server.prompt_count }}</span>
            </Button>
            <Button variant="action-neutral" size="action" @click="openEditDialog(server)" title="编辑配置">
              <IconEdit :size="14" />编辑
            </Button>
            <Button variant="action-danger" size="action" @click="handleDelete(server)" title="删除">
              <IconTrash :size="14" />删除
            </Button>
          </div>
        </article>
      </div>
    </EntityListLayout>

    <section v-if="addServiceVisible" class="add-service-panel">
      <div class="add-service-head">
        <div class="modal-title-block">
          <h3>添加 MCP 服务</h3>
          <p>从 Registry 搜索安装，或手动填写连接参数。</p>
        </div>
        <Button class="add-service-close" variant="ghost" size="icon" aria-label="收起" @click="addServiceVisible = false">
          <IconClose :size="16" />
        </Button>
      </div>
      <!-- 注：.add-subnav 是「添加服务」面板内的次级方式切换（手动 vs Registry），
           不是页面级 Tab；用局部 pill 切换更贴合折叠面板语境，故不复用 .adm-tabs。 -->
      <div class="add-subnav">
        <button type="button" class="add-subnav-btn" :class="{ 'add-subnav-btn--active': addMode === 'manual' }" @click="addMode = 'manual'">
          <IconPlus :size="15" />
          手动配置
        </button>
        <button type="button" class="add-subnav-btn" :class="{ 'add-subnav-btn--active': addMode === 'registry' }" @click="addMode = 'registry'">
          <IconSearch :size="15" />
          从 Registry 搜索
        </button>
      </div>
      <div v-if="addMode === 'manual'" class="add-pane">
        <div class="manual-install-form">
        <div class="form-grid two-col">
          <label class="field"><span>服务名称<em>*</em></span><Input v-model.trim="installForm.server_name" type="text" placeholder="唯一标识，如 my_server" /></label>
          <label class="field"><span>显示名称</span><Input v-model.trim="installForm.display_name" type="text" placeholder="前端展示名称" /></label>
        </div>
        <div class="field"><span>传输方式</span><CustomSelect :model-value="installForm.transport" :options="transportOptions" @update:model-value="installForm.transport = $event" /></div>
        <div v-if="installForm.transport === 'stdio'" class="form-grid">
          <label class="field"><span>命令<em>*</em></span><Input v-model.trim="installForm.command" type="text" placeholder="npx / uvx / python / node" /><small>启动 MCP 服务的可执行命令</small></label>
          <label class="field"><span>参数</span><Textarea v-model="installForm.argsJson" rows="4" class="font-mono-input" placeholder='["-y", "@scope/package"]'></Textarea><small>JSON 数组格式</small></label>
          <label class="field"><span>环境变量</span><Textarea v-model="installForm.envJson" rows="4" class="font-mono-input" placeholder='{"API_KEY": "..."}'></Textarea><small>JSON 对象，合并到 MCP 进程环境</small></label>
        </div>
        <div v-else class="form-grid">
          <label class="field"><span>URL<em>*</em></span><Input v-model.trim="installForm.url" type="url" placeholder="https://example.com/mcp" /><small>远程 MCP 服务端点</small></label>
          <label class="field"><span>Headers</span><Textarea v-model="installForm.headersJson" rows="4" class="font-mono-input" placeholder='{"Authorization": "Bearer ..."}'></Textarea><small>JSON 对象，作为请求头发送</small></label>
        </div>
        <div class="form-divider"></div>
        <div class="form-section-label">高级设置</div>
        <div class="form-grid two-col">
          <label class="field"><span>超时秒数</span><NumberInput :model-value="installForm.timeout" :min="1" :max="300" @update:model-value="installForm.timeout = $event" /></label>
          <label class="field"><span>风险等级</span><CustomSelect :model-value="installForm.risk_level" :options="riskOptions" @update:model-value="installForm.risk_level = $event" /></label>
        </div>
        <p class="form-hint">工具级风险覆盖:连接后在「工具」列表里按工具单独调整。</p>
        <div class="toggle-row">
          <label class="toggle-field"><Switch v-model:checked="installForm.enabled" /><span>启用服务</span></label>
          <label class="toggle-field"><Switch v-model:checked="installForm.auto_connect" /><span>自动连接</span></label>
          <label class="toggle-field"><Switch v-model:checked="installForm.trusted" /><span>受信任</span></label>
        </div>
        <div class="form-actions">
          <Button variant="ghost" size="sm" @click="resetInstallForm">重置</Button>
          <Button variant="default" size="sm" :disabled="installing" @click="submitManualInstall">
            <IconDownload v-if="!installing" :size="15" />
            <div v-else class="g-spinner g-spinner--sm"></div>
            <span>{{ installing ? '安装中...' : '安装服务' }}</span>
          </Button>
        </div>
        </div>
      </div>

      <div v-else class="add-pane">
        <div class="registry-search-bar">
        <div class="search-input-wrap">
          <IconSearch :size="16" />
          <input v-model.trim="registrySearch.query" type="text" placeholder="搜索服务名称，如 github / filesystem / mysql ..." class="registry-search-input" @keyup.enter="searchRegistryServers" />
        </div>
        <label class="toggle-field toggle-field--inline"><Switch v-model:checked="registrySearch.latest_only" /><span>仅最新版本</span></label>
        <Button variant="secondary" :disabled="loadingRegistryResults" @click="searchRegistryServers">{{ loadingRegistryResults ? '搜索中...' : '搜索' }}</Button>
      </div>

      <EntityListLayout
        v-if="loadingRegistryResults || !registryResults.length"
        title="Registry 结果"
        :loading="loadingRegistryResults"
        loading-text="正在搜索 Registry..."
        empty-title="暂无搜索结果"
        empty-hint="尝试输入关键词后点击搜索"
      />
      <div v-else class="registry-grid">
        <article v-for="item in registryResults" :key="`${item.name}-${item.version}`" class="registry-card">
          <div class="registry-card-head">
            <div class="registry-card-title">
              <h3>{{ item.display_name || item.name }}</h3>
              <div class="registry-card-meta"><code>{{ item.name }}</code><span class="version-tag">v{{ item.version }}</span><span v-if="item.latest" class="badge badge-success">Latest</span></div>
            </div>
          </div>
          <p class="registry-desc">{{ item.description || '暂无描述' }}</p>
          <div v-if="item.install_options?.length" class="install-options-row">
            <span v-for="option in item.install_options" :key="option.id" class="option-chip" :class="option.supported ? 'option-chip--ok' : 'option-chip--no'" :title="option.supported ? option.label : option.unsupported_reason">
              <IconCheck v-if="option.supported" :size="11" :stroke-width="2.5" />
              <IconClose v-else :size="11" :stroke-width="2.5" />
              {{ option.label }}
            </span>
          </div>
          <div v-if="firstUnsupportedReason(item)" class="inline-warning">
            <IconWarning :size="13" />
            {{ firstUnsupportedReason(item) }}
          </div>
          <div class="registry-card-actions">
            <Button size="sm" variant="default" :disabled="!item.installable || installingRegistry" @click="handleRegistryInstall(item)">{{ quickInstallButtonText(item) }}</Button>
            <Button size="sm" variant="secondary" :disabled="!item.install_options?.length" @click="openRegistryInstallDialog(item)">配置安装</Button>
            <div class="registry-links">
              <a v-if="item.website_url" class="ext-link" @click.prevent="openExternalLink(item.website_url)" href="#"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>官网</a>
              <a v-if="item.repository_url" class="ext-link" @click.prevent="openExternalLink(item.repository_url)" href="#"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7 3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>源码</a>
            </div>
          </div>
        </article>
      </div>
      <div v-if="registryNextCursor" class="load-more-row">
        <Button variant="secondary" :disabled="loadingMoreRegistry" @click="loadMoreRegistryServers">{{ loadingMoreRegistry ? '加载中...' : '加载更多结果' }}</Button>
      </div>
      </div>
    </section>

    <Dialog :open="registryInstallDialogVisible" @update:open="(v) => { if (!v) closeRegistryInstallDialog() }">
      <DialogContent class="max-w-[860px]">
        <DialogHeader>
          <DialogTitle class="sr-only">配置安装</DialogTitle>
          <div class="modal-title-block">
          <h3>配置安装</h3>
          <p>{{ selectedRegistryServer?.display_name || selectedRegistryServer?.name }}</p>
        </div>
        </DialogHeader>
      <div class="adm-modal-form">
        <div class="form-grid">
          <label class="field">
            <span>安装方式</span>
            <CustomSelect :model-value="registryInstallForm.option_id" :options="[{ value: '', label: '请选择安装方式' }, ...(selectedRegistryServer?.install_options || []).map(o => ({ value: o.id, label: o.supported ? o.label : `${o.label}（暂不支持）`, disabled: !o.supported }))]" placeholder="请选择安装方式" @update:model-value="registryInstallForm.option_id = $event; handleRegistryOptionChange($event)" />
            <small v-if="selectedRegistryOption?.command_preview">命令：{{ selectedRegistryOption.command_preview }}</small>
            <small v-if="selectedRegistryOption?.url_preview">地址：{{ selectedRegistryOption.url_preview }}</small>
            <small v-if="selectedRegistryOption?.unsupported_reason" class="text-warning">{{ selectedRegistryOption.unsupported_reason }}</small>
          </label>
        </div>
        <div class="form-grid two-col">
          <label class="field"><span>服务名称</span><Input v-model.trim="registryInstallForm.server_name" type="text" placeholder="本地唯一标识" /></label>
          <label class="field"><span>显示名称</span><Input v-model.trim="registryInstallForm.display_name" type="text" placeholder="页面展示名称" /></label>
        </div>
        <div v-if="selectedRegistryFields.length" class="form-grid two-col">
          <label v-for="field in selectedRegistryFields" :key="field.key" class="field">
            <span>{{ field.label }}<em v-if="field.required">*</em></span>
            <CustomSelect v-if="field.format === 'select'" :model-value="registryInstallForm.input_values[field.key]" :options="field.options || []" :placeholder="field.placeholder || ''" @update:model-value="registryInstallForm.input_values[field.key] = $event" />
            <Textarea v-else-if="field.format === 'textarea'" v-model="registryInstallForm.input_values[field.key]" rows="4" class="font-mono-input" :placeholder="field.placeholder || ''" />
            <Input v-else-if="field.format !== 'boolean'" v-model="registryInstallForm.input_values[field.key]" :type="field.secret ? 'password' : field.format === 'number' ? 'number' : 'text'" :placeholder="field.placeholder || ''" />
            <label v-else class="toggle-field toggle-field--inner"><Switch v-model:checked="registryInstallForm.input_values[field.key]" /><span>启用</span></label>
            <small v-if="field.description">{{ field.description }}</small>
            <small v-if="field.repeated">多值请用英文逗号分隔</small>
          </label>
        </div>
        <div class="form-divider"></div>
        <div class="form-grid two-col">
          <label class="field"><span>超时秒数</span><NumberInput :model-value="registryInstallForm.timeout" :min="1" :max="300" @update:model-value="registryInstallForm.timeout = $event" /></label>
          <label class="field"><span>风险等级</span><CustomSelect :model-value="registryInstallForm.risk_level" :options="riskOptions" @update:model-value="registryInstallForm.risk_level = $event" /></label>
        </div>
        <div class="toggle-row">
          <label class="toggle-field"><Switch v-model:checked="registryInstallForm.enabled" /><span>启用服务</span></label>
          <label class="toggle-field"><Switch v-model:checked="registryInstallForm.auto_connect" /><span>自动连接</span></label>
        </div>
      </div>
      <DialogFooter>
        <Button size="sm" @click="closeRegistryInstallDialog">取消</Button>
        <Button size="sm" variant="default" :disabled="installingRegistry || !selectedRegistryOption?.supported" @click="submitRegistryInstall()">{{ installingRegistry ? '安装中...' : '安装服务' }}</Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-if="editForm" :open="editDialogVisible" @update:open="(v) => { if (!v) closeEditDialog() }">
      <DialogContent class="max-w-[860px]">
        <DialogHeader>
          <DialogTitle class="sr-only">编辑 MCP 服务</DialogTitle>
          <div class="modal-title-block">
          <h3>编辑 MCP 服务</h3>
          <p class="font-mono">{{ editForm.name }}</p>
        </div>
        </DialogHeader>
      <div class="adm-modal-form">
        <div class="form-grid two-col">
          <label class="field"><span>显示名称</span><Input v-model="editForm.display_name" type="text" /></label>
          <div class="field"><span>传输方式</span><CustomSelect :model-value="editForm.transport" :options="transportOptions" @update:model-value="editForm.transport = $event" /></div>
        </div>
        <div v-if="editForm.transport === 'stdio'" class="form-grid">
          <label class="field"><span>命令</span><Input v-model="editForm.command" type="text" placeholder="如 npx / node / python" /></label>
          <label class="field"><span>参数列表 (JSON Array)</span><Textarea v-model="editForm.argsJson" rows="4" class="font-mono-input"></Textarea></label>
          <label class="field"><span>环境变量 (JSON Object)</span><Textarea v-model="editForm.envJson" rows="4" class="font-mono-input"></Textarea></label>
        </div>
        <div v-else class="form-grid">
          <label class="field"><span>URL</span><Input v-model="editForm.url" type="url" placeholder="http://localhost:8080/mcp" /></label>
          <label class="field"><span>Headers (JSON Object)</span><Textarea v-model="editForm.headersJson" rows="4" class="font-mono-input"></Textarea></label>
        </div>
        <div class="form-divider"></div>
        <div class="form-grid two-col">
          <div class="field"><span>超时秒数</span><NumberInput :model-value="editForm.timeout" :min="1" :max="300" @update:model-value="editForm.timeout = $event" /></div>
          <div class="field"><span>风险等级</span><CustomSelect :model-value="editForm.risk_level" :options="riskOptions" @update:model-value="editForm.risk_level = $event" /></div>
        </div>
        <p class="form-hint">工具级风险覆盖:连接后在「工具」列表里按工具单独调整。</p>
        <div class="toggle-row">
          <label class="toggle-field"><Switch v-model:checked="editForm.enabled" /><span>启用服务</span></label>
          <label class="toggle-field"><Switch v-model:checked="editForm.auto_connect" /><span>自动连接</span></label>
          <label class="toggle-field"><Switch v-model:checked="editForm.trusted" /><span>受信任</span></label>
        </div>
      </div>
      <DialogFooter>
        <Button size="sm" @click="closeEditDialog">取消</Button>
        <Button size="sm" variant="default" :disabled="savingEdit" @click="saveEdit">{{ savingEdit ? '保存中...' : '保存更改' }}</Button>
      </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="toolsDialogVisible" @update:open="(v) => { if (!v) closeToolsDialog() }">
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <div class="modal-title-block">
          <DialogTitle>工具列表</DialogTitle>
          <p>{{ activeToolsServerName }}</p>
        </div>
        </DialogHeader>
      <EntityListLayout
        v-if="!serverTools.length"
        title="工具列表"
        empty-title="暂无工具"
        empty-hint="服务未声明任何工具，或连接未成功"
      />
      <ul v-else class="tool-list">
        <li v-for="(tool, idx) in serverTools" :key="tool.function?.name || idx" class="tool-item">
          <div class="tool-item-head">
            <code class="tool-name">{{ tool.function?.original_tool_name || tool.function?.name || '-' }}</code>
            <div class="tool-risk-select">
              <span class="tool-risk-label">风险</span>
              <CustomSelect :model-value="tool.function?.risk_level || 'medium'" :options="riskOptions" @update:model-value="updateToolRisk(tool, $event)" />
            </div>
          </div>
          <p class="tool-desc">{{ tool.function?.description || '暂无描述' }}</p>
          <div v-if="tool.function?.annotations" class="tool-annotations">
            <span v-if="tool.function.annotations.readOnlyHint" class="anno-chip">只读</span>
            <span v-if="tool.function.annotations.destructiveHint" class="anno-chip anno-chip--warn">破坏性</span>
            <span v-if="tool.function.annotations.idempotentHint" class="anno-chip">幂等</span>
          </div>
          <div v-if="getToolMetrics(tool)" class="tool-metrics">
            调用 {{ getToolMetrics(tool).calls }} 次<span v-if="getToolMetrics(tool).failures"> · 失败 {{ getToolMetrics(tool).failures }}</span> · 平均 {{ Math.round(getToolMetrics(tool).total_duration_ms / getToolMetrics(tool).calls) }}ms
          </div>
          <div v-if="toolParameters(tool).length" class="tool-params">
            <div class="tool-params-label">参数</div>
            <div v-for="param in toolParameters(tool)" :key="param.name" class="param-row">
              <code class="param-name">{{ param.name }}</code>
              <span class="param-type">{{ param.type }}</span>
              <span v-if="param.required" class="param-required">必填</span>
              <span v-if="param.description" class="param-desc">{{ param.description }}</span>
            </div>
          </div>
        </li>
      </ul>
      </DialogContent>
    </Dialog>

    <Dialog :open="resourcesDialogVisible" @update:open="(v) => { if (!v) closeResourcesDialog() }">
      <DialogContent class="max-w-[640px]">
        <DialogHeader>
          <div class="modal-title-block">
          <DialogTitle>资源列表</DialogTitle>
          <p>{{ activeResourcesServer?.display_name || activeResourcesServer?.name }}</p>
        </div>
        </DialogHeader>
      <EntityListLayout
        v-if="!serverResources.length"
        title="资源列表"
        empty-title="暂无资源"
        empty-hint="服务未声明 resources 能力面，或连接未成功"
      />
      <ul v-else class="tool-list">
        <li v-for="(resource, idx) in serverResources" :key="resource.uri || idx" class="tool-item">
          <div class="tool-item-head"><code class="tool-name">{{ resource.name }}</code><code class="tool-desc">{{ resource.uri }}</code></div>
          <p v-if="resource.description" class="tool-desc">{{ resource.description }}</p>
          <button class="adm-btn adm-btn--sm" @click="toggleResource(resource)">{{ resource.expanded ? '收起' : (resource.loading ? '读取中...' : '读取内容') }}</button>
          <pre v-if="resource.expanded && resource.content" class="detail-code">{{ JSON.stringify(resource.content, null, 2) }}</pre>
        </li>
      </ul>
      </DialogContent>
    </Dialog>

    <Dialog :open="promptsDialogVisible" @update:open="(v) => { if (!v) closePromptsDialog() }">
      <DialogContent class="max-w-[560px]">
        <DialogHeader>
          <div class="modal-title-block">
          <DialogTitle>提示词列表</DialogTitle>
          <p>{{ activePromptsServer?.display_name || activePromptsServer?.name }}</p>
        </div>
        </DialogHeader>
      <EntityListLayout
        v-if="!serverPrompts.length"
        title="提示词列表"
        empty-title="暂无提示词"
        empty-hint="服务未声明 prompts 能力面，或连接未成功"
      />
      <ul v-else class="tool-list">
        <li v-for="(prompt, idx) in serverPrompts" :key="prompt.name || idx" class="tool-item">
          <div class="tool-item-head"><code class="tool-name">{{ prompt.name }}</code></div>
          <p class="tool-desc">{{ prompt.description || '暂无描述' }}</p>
          <div v-if="prompt.arguments?.length" class="tool-params">
            <div class="tool-params-label">参数</div>
            <div v-for="arg in prompt.arguments" :key="arg.name" class="param-row">
              <code class="param-name">{{ arg.name }}</code>
              <span v-if="arg.required" class="param-required">必填</span>
              <span v-if="arg.description" class="param-desc">{{ arg.description }}</span>
            </div>
          </div>
        </li>
      </ul>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref, h } from 'vue';
import CustomSelect from '../components/ui/CustomSelect.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import NumberInput from '../components/NumberInput.vue';
import { Switch } from '../components/ui/switch';
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import IconCheck from '../components/icons/IconCheck.vue';
import IconClose from '../components/icons/IconClose.vue';
import IconPlus from '../components/icons/IconPlus.vue';
import IconDownload from '../components/icons/IconDownload.vue';
import IconEdit from '../components/icons/IconEdit.vue';
import IconSearch from '../components/icons/IconSearch.vue';
import IconTrash from '../components/icons/IconTrash.vue';
import IconWarning from '../components/icons/IconWarning.vue';
import IconInfo from '../components/icons/IconInfo.vue';
import { UiBadge } from '../components/ui';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import {
  addMCPServer, connectMCPServer, deleteMCPServer, disconnectMCPServer,
  getMCPServerTools, getMCPServerMetrics, installMCPRegistryServer, listMCPRegistryServers,
  listMCPServers, listMCPServerResources, listMCPServerPrompts,
  readMCPServerResource, testMCPServer, updateMCPServer,
} from '../api/mcpService';
import { useMcpStore } from '../stores/mcp.js';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const toast = useToast();
const { confirm } = useConfirm();

const SVG = { xmlns: 'http://www.w3.org/2000/svg', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const IconTotal = () => h('svg', SVG, [h('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }), h('line', { x1: 8, y1: 21, x2: 16, y2: 21 }), h('line', { x1: 12, y1: 17, x2: 12, y2: 21 })]);
const IconConnected = () => h('svg', SVG, [h('path', { d: 'M5 12.55a11 11 0 0 1 14.08 0' }), h('path', { d: 'M1.42 9a16 16 0 0 1 21.16 0' }), h('path', { d: 'M8.53 16.11a6 6 0 0 1 6.95 0' }), h('line', { x1: 12, y1: 20, x2: 12.01, y2: 20 })]);
const IconEnabled = () => h('svg', SVG, [h('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }), h('polyline', { points: '22 4 12 14.01 9 11.01' })]);
const IconTools = () => h('svg', SVG, [h('path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' })]);

const addServiceVisible = ref(false);
const addMode = ref('manual');

const servers = ref([]);
const registryResults = ref([]);
const registryNextCursor = ref('');
const serverTools = ref([]);
const activeToolsServerName = ref('');
const activeToolsServer = ref(null);
const serverMetrics = ref({});
const serverResources = ref([]);
const resourcesDialogVisible = ref(false);
const activeResourcesServer = ref(null);
const serverPrompts = ref([]);
const promptsDialogVisible = ref(false);
const activePromptsServer = ref(null);
const selectedRegistryServer = ref(null);
const registryInstallDialogVisible = ref(false);
const editDialogVisible = ref(false);
const toolsDialogVisible = ref(false);
const editForm = ref(null);

const riskOptions = [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }];
const transportOptions = [
  { value: 'stdio', label: 'stdio（本地进程）' },
  { value: 'sse', label: 'SSE（Server-Sent Events）' },
  { value: 'streamable_http', label: 'Streamable HTTP' },
];

const installForm = reactive({ server_name: '', display_name: '', transport: 'stdio', command: '', argsJson: '[]', envJson: '{}', url: '', headersJson: '{}', enabled: true, auto_connect: true, timeout: 30, risk_level: 'medium', toolRiskOverridesJson: '{}', trusted: true });
const registrySearch = reactive({ query: '', latest_only: true, limit: 6 });
const registryInstallForm = reactive({ option_id: '', server_name: '', display_name: '', enabled: true, auto_connect: true, timeout: 30, risk_level: 'medium', input_values: {} });

const summary = computed(() => ({
  total: servers.value.length,
  connected: servers.value.filter((s) => s.status === 'connected').length,
  enabled: servers.value.filter((s) => s.enabled).length,
  tools: servers.value.reduce((sum, s) => sum + (s.tool_count || 0), 0),
}));
const kpiItems = computed(() => [
  { key: 'total', label: '服务总数', value: summary.value.total, icon: IconTotal },
  { key: 'connected', label: '已连接', value: summary.value.connected, icon: IconConnected },
  { key: 'enabled', label: '已启用', value: summary.value.enabled, icon: IconEnabled },
  { key: 'tools', label: '可用工具', value: summary.value.tools, icon: IconTools },
]);
const selectedRegistryOption = computed(() => selectedRegistryServer.value?.install_options?.find((o) => o.id === registryInstallForm.option_id) || null);
const selectedRegistryFields = computed(() => selectedRegistryOption.value?.form_fields || []);

function openExternalLink(url) { window.open(url, '_blank', 'noopener,noreferrer'); }
function statusBadgeTone(status) {
  if (status === 'connected') return 'success';
  if (status === 'connecting') return 'warning';
  if (status === 'error') return 'error';
  return 'neutral';
}
function formatArgs(args) { return Array.isArray(args) && args.length ? args.join(' ') : ''; }
function resetInstallForm() {
  Object.assign(installForm, { server_name: '', display_name: '', transport: 'stdio', command: '', argsJson: '[]', envJson: '{}', url: '', headersJson: '{}', enabled: true, auto_connect: true, timeout: 30, risk_level: 'medium', toolRiskOverridesJson: '{}', trusted: true });
}
function defaultFieldValue(field) {
  if (field.default_value !== null && field.default_value !== undefined) return field.default_value;
  if (field.format === 'select') return field.options?.[0]?.value ?? '';
  if (field.format === 'boolean') return false;
  return '';
}
function initializeRegistryInputValues(option) {
  const values = {};
  (option?.form_fields || []).forEach((f) => { values[f.key] = defaultFieldValue(f); });
  registryInstallForm.input_values = values;
}
function getPreferredInstallOption(server) {
  return server?.install_options?.find((o) => o.id === server.preferred_option_id) || server?.install_options?.find((o) => o.supported) || server?.install_options?.[0] || null;
}
function countSupportedInstallOptions(server) { return (server?.install_options || []).filter((o) => o.supported).length; }
function canQuickInstall(server) {
  const option = getPreferredInstallOption(server);
  if (!option?.supported) return false;
  if (countSupportedInstallOptions(server) !== 1) return false;
  return !(option.form_fields || []).some((f) => f.required && (f.default_value === null || f.default_value === undefined || f.default_value === ''));
}
function quickInstallButtonText(server) { return canQuickInstall(server) ? '一键安装' : '安装'; }
function firstUnsupportedReason(server) { return server?.install_options?.find((o) => !o.supported)?.unsupported_reason || ''; }
function applyRegistryInstallDefaults(server, option) {
  registryInstallForm.option_id = option?.id || '';
  registryInstallForm.server_name = option?.default_server_name || server?.default_server_name || '';
  registryInstallForm.display_name = option?.default_display_name || server?.default_display_name || server?.display_name || '';
  registryInstallForm.enabled = true;
  registryInstallForm.auto_connect = true;
  registryInstallForm.timeout = option?.default_timeout || 30;
  registryInstallForm.risk_level = option?.default_risk_level || 'medium';
  initializeRegistryInputValues(option);
}
function openRegistryInstallDialog(server) { selectedRegistryServer.value = server; applyRegistryInstallDefaults(server, getPreferredInstallOption(server)); registryInstallDialogVisible.value = true; }
function closeRegistryInstallDialog() { registryInstallDialogVisible.value = false; }
function handleRegistryOptionChange(optionId) {
  const option = selectedRegistryServer.value?.install_options?.find((o) => o.id === optionId);
  if (!option) return;
  registryInstallForm.timeout = option.default_timeout || registryInstallForm.timeout;
  registryInstallForm.risk_level = option.default_risk_level || registryInstallForm.risk_level;
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
    toolRiskOverridesJson: JSON.stringify(server.tool_risk_overrides || {}, null, 2),
    trusted: server.trusted ?? true,
  };
  editDialogVisible.value = true;
}
function closeEditDialog() { editDialogVisible.value = false; editForm.value = null; }
function closeToolsDialog() { toolsDialogVisible.value = false; }
function openAddService() {
  addServiceVisible.value = true;
  nextTick(() => {
    document.querySelector('.add-service-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

const { run: runLoadServers, loading: loadingServers } = useAsyncAction(
  async () => {
    const res = await listMCPServers();
    servers.value = res.data || [];
    useMcpStore().reloadPrompts();
  },
  { errorPrefix: '加载服务失败' },
);
function refreshAll() { runLoadServers(); }

const { run: runSearch, loading: loadingRegistryResults } = useAsyncAction(
  async (opts = {}) => {
    const append = opts.append === true;
    if (append && !registryNextCursor.value) return;
    const res = await listMCPRegistryServers({ search: registrySearch.query, limit: registrySearch.limit, cursor: append ? registryNextCursor.value : '', latest_only: registrySearch.latest_only });
    const items = res.data?.items || [];
    registryResults.value = append ? [...registryResults.value, ...items] : items;
    registryNextCursor.value = res.data?.next_cursor || '';
  },
  { errorPrefix: '搜索 Registry 失败', showErrorToast: false },
);
function searchRegistryServers() { runSearch({ append: false }); }
const { run: runLoadMore, loading: loadingMoreRegistry } = useAsyncAction(
  () => runSearch({ append: true }),
  { showErrorToast: false },
);
function loadMoreRegistryServers() { runLoadMore(); }

const { run: runInstall, loading: installing } = useAsyncAction(
  async (payload) => {
    await addMCPServer(payload);
    resetInstallForm();
    await runLoadServers();
    addServiceVisible.value = false;
  },
  { successMessage: (r) => r?.message || '安装成功', errorPrefix: '安装失败' },
);
function submitManualInstall() {
  if (!installForm.server_name) return toast.warning('请填写服务名称');
  const isStdio = installForm.transport === 'stdio';
  if (isStdio && !installForm.command) return toast.warning('请填写启动命令');
  if (!isStdio && !installForm.url) return toast.warning('请填写 URL');
  let parsedArgs, parsedEnv, parsedHeaders, parsedToolRiskOverrides;
  try {
    if (isStdio) { parsedArgs = JSON.parse(installForm.argsJson || '[]'); parsedEnv = JSON.parse(installForm.envJson || '{}'); }
    else { parsedHeaders = JSON.parse(installForm.headersJson || '{}'); }
    parsedToolRiskOverrides = JSON.parse(installForm.toolRiskOverridesJson || '{}');
  } catch (e) { return toast.warning('JSON 格式错误'); }
  const payload = {
    name: installForm.server_name, display_name: installForm.display_name || installForm.server_name,
    transport: installForm.transport, enabled: installForm.enabled, auto_connect: installForm.auto_connect,
    timeout: installForm.timeout, risk_level: installForm.risk_level, tool_risk_overrides: parsedToolRiskOverrides, trusted: installForm.trusted,
    ...(isStdio ? { command: installForm.command, args: parsedArgs, env: parsedEnv } : { url: installForm.url, headers: parsedHeaders }),
  };
  runInstall(payload);
}

const { run: runRegistryInstall, loading: installingRegistry } = useAsyncAction(
  async (payload) => {
    await installMCPRegistryServer(payload);
    closeRegistryInstallDialog();
    await runLoadServers();
    addServiceVisible.value = false;
  },
  { successMessage: (r) => r?.message || '安装成功', errorPrefix: 'Registry 安装失败' },
);
function submitRegistryInstall(customPayload = null) {
  const option = selectedRegistryOption.value || customPayload?.install_option;
  if (!option) return toast.warning('请选择一个可用的安装方式');
  if (!option.supported) return toast.warning(option.unsupported_reason || '当前安装方式暂不支持');
  const payload = customPayload || {
    install_option: option, server_name: registryInstallForm.server_name, display_name: registryInstallForm.display_name,
    enabled: registryInstallForm.enabled, auto_connect: registryInstallForm.auto_connect, timeout: registryInstallForm.timeout,
    risk_level: registryInstallForm.risk_level, input_values: registryInstallForm.input_values,
  };
  const missing = (option.form_fields || []).find((f) => f.required && (payload.input_values?.[f.key] === '' || payload.input_values?.[f.key] == null));
  if (missing) return toast.warning(`请填写 ${missing.label}`);
  runRegistryInstall(payload);
}
function handleRegistryInstall(server) {
  const option = getPreferredInstallOption(server);
  if (!option?.supported) return toast.warning(firstUnsupportedReason(server) || '当前没有可用安装方式');
  if (!canQuickInstall(server)) { openRegistryInstallDialog(server); return; }
  submitRegistryInstall({
    install_option: option,
    server_name: option.default_server_name || server.default_server_name,
    display_name: option.default_display_name || server.default_display_name,
    enabled: true, auto_connect: true, timeout: option.default_timeout || 30, risk_level: option.default_risk_level || 'medium',
    input_values: Object.fromEntries((option.form_fields || []).map((f) => [f.key, defaultFieldValue(f)])),
  });
}

const { run: runSaveEdit, loading: savingEdit } = useAsyncAction(
  async () => {
    if (!editForm.value) return;
    let parsedArgs = [], parsedEnv = {}, parsedHeaders = {};
    let parsedToolRiskOverrides = {};
    if (editForm.value.transport === 'stdio') { parsedArgs = JSON.parse(editForm.value.argsJson || '[]'); parsedEnv = JSON.parse(editForm.value.envJson || '{}'); }
    else { parsedHeaders = JSON.parse(editForm.value.headersJson || '{}'); }
    parsedToolRiskOverrides = JSON.parse(editForm.value.toolRiskOverridesJson || '{}');
    const isStdio = editForm.value.transport === 'stdio';
    const res = await updateMCPServer(editForm.value.name, {
      display_name: editForm.value.display_name, transport: editForm.value.transport,
      enabled: editForm.value.enabled, auto_connect: editForm.value.auto_connect, timeout: editForm.value.timeout, risk_level: editForm.value.risk_level, tool_risk_overrides: parsedToolRiskOverrides, trusted: editForm.value.trusted,
      command: isStdio ? editForm.value.command : null, args: isStdio ? parsedArgs : [], env: isStdio ? parsedEnv : {},
      headers: isStdio ? {} : parsedHeaders, url: isStdio ? null : editForm.value.url,
    });
    closeEditDialog();
    await runLoadServers();
    return res;
  },
  { successMessage: (r) => r?.message || '保存成功', errorPrefix: '保存失败' },
);
function saveEdit() { runSaveEdit(); }

const { run: runConnect } = useAsyncAction(
  async (server) => { const res = await connectMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '连接成功', errorPrefix: '连接失败' },
);
function handleConnect(server) { runConnect(server); }
const { run: runDisconnect } = useAsyncAction(
  async (server) => { const res = await disconnectMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '断开成功', errorPrefix: '断开失败' },
);
function handleDisconnect(server) { runDisconnect(server); }
const { run: runTest } = useAsyncAction(
  async (server) => { const res = await testMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '测试成功', errorPrefix: '测试失败' },
);
function handleTest(server) { runTest(server); }

const { run: runShowTools } = useAsyncAction(
  async (server) => {
    const [toolsRes, metricsRes] = await Promise.all([
      getMCPServerTools(server.name),
      getMCPServerMetrics(server.name).catch(() => null),
    ]);
    serverTools.value = toolsRes.data?.tools || [];
    const metricsMap = {};
    for (const m of (metricsRes?.data?.tools || [])) {
      metricsMap[m.tool_name] = m;
    }
    serverMetrics.value = metricsMap;
    activeToolsServer.value = server;
    activeToolsServerName.value = server.display_name || server.name;
    toolsDialogVisible.value = true;
  },
  { errorPrefix: '加载工具失败' },
);
function showTools(server) { runShowTools(server); }

function toolParameters(tool) {
  const params = tool?.function?.parameters;
  if (!params || typeof params !== 'object') return [];
  const props = params.properties || {};
  const required = new Set(params.required || []);
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type: schema?.type || (schema?.$ref ? 'ref' : 'any'),
    description: schema?.description || '',
    required: required.has(name),
  }));
}

function getToolMetrics(tool) {
  const name = tool?.function?.original_tool_name || tool?.function?.name;
  return name ? serverMetrics.value[name] : null;
}

async function updateToolRisk(tool, newRisk) {
  const server = activeToolsServer.value;
  const toolName = tool?.function?.original_tool_name || tool?.function?.name;
  if (!server || !toolName) return;
  const overrides = { ...(server.tool_risk_overrides || {}) };
  overrides[toolName] = newRisk;
  // updateMCPServer 是全量更新(后端 {...existing, ...payload}),须传完整 payload 保留 server 现状。
  const isStdio = (server.transport || 'stdio') === 'stdio';
  const payload = {
    display_name: server.display_name || server.name,
    transport: server.transport || 'stdio',
    enabled: server.enabled,
    auto_connect: server.auto_connect,
    timeout: server.timeout || 30,
    risk_level: server.risk_level || 'medium',
    tool_risk_overrides: overrides,
    trusted: server.trusted ?? true,
    ...(isStdio ? { command: server.command || '', args: server.args || [], env: server.env || {} } : { url: server.url || '', headers: server.headers || {} }),
  };
  try {
    await updateMCPServer(server.name, payload);
    server.tool_risk_overrides = overrides;
    if (tool.function) tool.function.risk_level = newRisk;
    toast.success(`${toolName} 风险已设为 ${newRisk}`);
  } catch { /* useAsyncAction 已提示 */ }
}
async function showResources(server) {
  try {
    const res = await listMCPServerResources(server.name);
    serverResources.value = (res.data?.resources || []).map((r) => ({ ...r, expanded: false, content: null, loading: false }));
    activeResourcesServer.value = server;
    resourcesDialogVisible.value = true;
  } catch { /* ignore */ }
}
function closeResourcesDialog() { resourcesDialogVisible.value = false; }
async function toggleResource(resource) {
  if (resource.content !== null) { resource.expanded = !resource.expanded; return; }
  resource.loading = true;
  try {
    const res = await readMCPServerResource(activeResourcesServer.value.name, resource.uri);
    resource.content = res.data?.contents || [];
    resource.expanded = true;
  } finally { resource.loading = false; }
}
async function showPrompts(server) {
  try {
    const res = await listMCPServerPrompts(server.name);
    serverPrompts.value = res.data?.prompts || [];
    activePromptsServer.value = server;
    promptsDialogVisible.value = true;
  } catch { /* ignore */ }
}
function closePromptsDialog() { promptsDialogVisible.value = false; }

const { run: runDelete } = useAsyncAction(
  async (server) => { const res = await deleteMCPServer(server.name); await runLoadServers(); return res; },
  { successMessage: (r) => r?.message || '删除成功', errorPrefix: '删除失败' },
);
async function handleDelete(server) {
  const ok = await confirm({ message: `确定删除 MCP 服务“${server.display_name || server.name}”吗？`, confirmText: '删除', danger: true });
  if (!ok) return;
  runDelete(server);
}

onMounted(() => {
  runLoadServers();
  runSearch({ append: false });
});
</script>

<style scoped>
.add-service-panel { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-lg); border-radius: var(--radius-xl); border: 1px solid var(--color-border); background: var(--color-bg-secondary); box-shadow: none; scroll-margin-top: var(--spacing-md); }
.add-service-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-md); }
.add-service-close { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; flex-shrink: 0; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: transparent; color: var(--color-text-secondary); cursor: pointer; transition: all var(--transition-fast); }
.add-service-close:hover { border-color: var(--color-border-hover); background: var(--color-hover-overlay-md); color: var(--color-text-primary); }
.add-subnav { display: flex; gap: var(--spacing-xs); padding: var(--spacing-xs); border-radius: var(--radius-md); background: transparent; border: 1px solid var(--color-border); width: fit-content; }
.add-subnav-btn { display: inline-flex; align-items: center; gap: var(--spacing-sm); padding: 8px 14px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-secondary); font: inherit; font-size: var(--font-size-sm); font-weight: 500; cursor: pointer; white-space: nowrap; transition: all var(--transition-fast); }
.add-subnav-btn:hover { color: var(--color-text-primary); }
.add-subnav-btn--active { background: var(--color-bg-tertiary); color: var(--color-text-primary); font-weight: 600; box-shadow: var(--shadow-sm); }
.add-pane { display: flex; flex-direction: column; gap: var(--spacing-md); }

.server-grid { display: flex; flex-direction: column; gap: 8px; }
.server-card { display: flex; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-lg); }
.server-card__main { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.server-card-head { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1; }
.server-card-icon { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--radius-sm); flex-shrink: 0; border: 1px solid var(--color-border); background: transparent; color: var(--color-text-secondary); }
.server-card-icon svg { width: 14px; height: 14px; }
.server-card-info { flex: 1; min-width: 0; }
.server-card-name { font-weight: 600; font-size: var(--font-size-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.server-card-sub { display: flex; align-items: baseline; gap: var(--spacing-sm); margin-top: 2px; min-width: 0; }
.server-card-id { color: var(--color-text-muted); font-size: var(--font-size-xs); font-family: var(--font-mono); flex-shrink: 0; }
.server-card-conn { color: var(--color-text-muted); font-size: var(--font-size-xs); font-family: var(--font-mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.server-card-badges { display: flex; align-items: center; gap: var(--spacing-xs); flex-shrink: 0; }

.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot--connected { background: var(--color-success); box-shadow: none; }
.status-dot--connecting { background: var(--color-warning); animation: pulse-dot 1s ease-in-out infinite; }
.status-dot--error { background: var(--color-error); }
.status-dot--unknown { background: var(--color-text-muted); }
@keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.server-meta-row { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); min-width: 0; }
.meta-chip { display: inline-flex; align-items: center; gap: var(--spacing-xs); padding: 4px 10px; border-radius: var(--radius-sm); background: var(--color-hover-overlay-md); color: var(--color-text-secondary); font-size: var(--font-size-xs); font-weight: 600; line-height: 1.2; }
.meta-chip-label { color: var(--color-text-muted); }
.meta-chip-value { color: var(--color-text-primary); font-weight: 500; }
.meta-chip-value--mono { font-family: var(--font-mono); }
.risk--low { color: var(--color-success); }
.risk--medium { color: var(--color-warning); }
.risk--high { color: var(--color-error); }
.text-success { color: var(--color-success); }
.text-muted { color: var(--color-text-muted); }

.server-connection-info { background: var(--color-bg-secondary); border-radius: var(--radius-sm); padding: 7px 10px; min-width: 0; }
.connection-code { font-family: var(--font-mono); font-size: var(--font-size-xs); color: var(--color-text-secondary); word-break: break-all; display: block; }

.error-banner { display: flex; align-items: flex-start; gap: var(--spacing-xs); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-md); background: rgba(var(--color-error-rgb), 0.08); border: 1px solid rgba(var(--color-error-rgb), 0.2); color: var(--color-error); font-size: var(--font-size-xs); }
.server-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; padding-top: var(--spacing-sm); border-top: 1px solid var(--color-border); }

.manual-install-form { display: flex; flex-direction: column; gap: var(--spacing-md); }
.form-divider { height: 1px; background: var(--color-border); margin: var(--spacing-xs) 0; }
.form-section-label { font-size: var(--font-size-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted); }
.adm-modal-form { display: flex; flex-direction: column; gap: var(--spacing-md); }

.form-grid { display: grid; gap: var(--spacing-md); }
.form-grid.two-col { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.field { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.field > span, .field > label { font-size: var(--font-size-xs); color: var(--color-text-secondary); letter-spacing: 0.02em; }
.field em { color: var(--color-error); font-style: normal; margin-left: 3px; }
.field small { color: var(--color-text-muted); font-size: var(--font-size-xs); }
.font-mono-input { font-family: var(--font-mono); font-size: var(--font-size-xs); }
.font-mono { font-family: var(--font-mono); }

.toggle-field { display: inline-flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-size: var(--font-size-sm); color: var(--color-text-secondary); user-select: none; }
.toggle-field--inline { align-self: flex-end; padding-bottom: 9px; }
.toggle-field--inner { padding-top: 6px; }
.toggle-row { display: flex; flex-wrap: wrap; gap: var(--spacing-lg); padding: 2px 0; }
.form-actions { display: flex; justify-content: flex-end; gap: var(--spacing-sm); padding-top: var(--spacing-md); border-top: 1px solid var(--color-border); margin-top: auto; }

.registry-search-bar { display: flex; align-items: center; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-md); border: 1px solid var(--color-border); background: transparent; }
.search-input-wrap { flex: 1; display: flex; align-items: center; gap: var(--spacing-sm); color: var(--color-text-muted); }
.registry-search-input { flex: 1; background: transparent; border: none; outline: none; color: var(--color-text-primary); font: inherit; font-size: var(--font-size-sm); }
.registry-search-input::placeholder { color: var(--color-text-muted); }

.registry-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--spacing-md); }
.registry-card { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-md); border-radius: var(--radius-lg); border: 1px solid var(--color-border); background: var(--color-bg-secondary); transition: border-color var(--transition-fast), background var(--transition-fast); }
.registry-card:hover { border-color: var(--color-border-hover); background: var(--color-hover-overlay-md); }
.registry-card-head { display: flex; align-items: flex-start; gap: var(--spacing-md); }
.registry-card-title { flex: 1; min-width: 0; }
.registry-card-title h3 { font-size: var(--font-size-base); font-weight: 600; margin: 0 0 4px; }
.registry-card-meta { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-xs); font-size: var(--font-size-xs); color: var(--color-text-muted); }
.registry-card-meta code { font-family: var(--font-mono); }
.version-tag { padding: 2px 6px; border-radius: var(--radius-sm); background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-family: var(--font-mono); color: var(--color-text-secondary); }
.registry-desc { color: var(--color-text-secondary); font-size: var(--font-size-sm); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.install-options-row { display: flex; flex-wrap: wrap; gap: 6px; }
.option-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: var(--radius-full); font-size: 11px; border: 1px solid transparent; }
.option-chip--ok { background: rgba(var(--color-success-rgb), 0.1); border-color: rgba(var(--color-success-rgb), 0.25); color: var(--color-success); }
.option-chip--no { background: rgba(var(--color-error-rgb), 0.07); border-color: rgba(var(--color-error-rgb), 0.15); color: var(--color-text-muted); }
.inline-warning { display: flex; align-items: flex-start; gap: var(--spacing-xs); color: var(--color-warning); font-size: var(--font-size-xs); }
.registry-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-xs); padding-top: var(--spacing-xs); border-top: 1px solid var(--color-border); margin-top: auto; }
.registry-links { display: flex; gap: var(--spacing-xs); margin-left: auto; }
.ext-link { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; border-radius: var(--radius-md); font-size: var(--font-size-xs); color: var(--color-text-muted); text-decoration: none; border: 1px solid transparent; transition: all 0.2s; cursor: pointer; }
.ext-link:hover { color: var(--color-text-primary); border-color: var(--color-border); background: var(--color-hover-overlay); }
.load-more-row { display: flex; justify-content: center; }

.badge { display: inline-flex; align-items: center; justify-content: center; border-radius: var(--radius-full); padding: 3px 9px; font-size: 11px; font-weight: 500; border: 1px solid transparent; }
.badge-success { background: rgba(var(--color-success-rgb), 0.12); color: var(--color-success); border-color: rgba(var(--color-success-rgb), 0.25); }
.text-warning { color: var(--color-warning); }

.modal-title-block :is(h2, h3) { font-size: var(--font-size-lg); margin: 0 0 2px; }
.modal-title-block p { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }

.tool-list { display: flex; flex-direction: column; gap: var(--spacing-sm); list-style: none; margin: 0; padding: 0; }
.tool-item { padding: var(--spacing-md); border-radius: var(--radius-lg); background: var(--color-bg-secondary); border: 1px solid var(--color-border); }
.tool-item:hover { border-color: var(--color-border); }
.tool-item-head { margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); flex-wrap: wrap; }
.tool-name { font-family: var(--font-mono); font-size: var(--font-size-sm); color: var(--color-brand-accent-light); background: rgba(var(--color-brand-accent-rgb), 0.1); padding: 2px 8px; border-radius: var(--radius-sm); }
.tool-desc { color: var(--color-text-secondary); font-size: var(--font-size-sm); margin: 0; }
.tool-risk-select { display: flex; align-items: center; gap: 6px; width: 150px; flex-shrink: 0; }
.tool-risk-label { font-size: var(--font-size-sm); color: var(--color-text-secondary); white-space: nowrap; flex-shrink: 0; }
.tool-risk-select :deep(.custom-select) { flex: 1; min-width: 0; }
.tool-risk-select :deep(.select-trigger:hover:not(.disabled)) { border-color: var(--color-border); }
.tool-annotations { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.tool-metrics { margin-top: 4px; font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.anno-chip { font-size: var(--font-size-sm); padding: 1px 6px; border-radius: var(--radius-sm); background: var(--color-bg-secondary); color: var(--color-text-secondary); border: 1px solid var(--color-border); }
.anno-chip--warn { color: var(--color-warning); border-color: var(--color-warning); }
.tool-params { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--color-border); }
.tool-params-label { font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-bottom: 4px; }
.param-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: var(--font-size-sm); margin-bottom: 2px; }
.param-name { font-family: var(--font-mono); color: var(--color-text-primary, var(--color-text-secondary)); }
.param-type { color: var(--color-text-secondary); font-style: italic; }
.param-required { color: var(--color-error); font-size: 11px; padding: 0 4px; border: 1px solid var(--color-error); border-radius: var(--radius-sm); }
.param-desc { color: var(--color-text-secondary); }
.form-hint { font-size: var(--font-size-sm); color: var(--color-text-secondary); margin: 4px 0 0; }

@media (max-width: 720px) {
  .registry-grid { grid-template-columns: 1fr; }
  .form-grid.two-col { grid-template-columns: 1fr; }
  .registry-search-bar { flex-wrap: wrap; }
  .section-toolbar { flex-direction: column; align-items: stretch; }
  .form-actions { flex-wrap: wrap; justify-content: flex-start; }
}
</style>
