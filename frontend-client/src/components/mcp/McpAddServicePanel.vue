<!-- eslint-disable vue/no-mutating-props -- installForm/registrySearch 为视图持有的 reactive 表单对象，面板内改写属有意的表单模型架构 -->
<template>
  <section class="add-service-panel">
    <div class="add-service-head">
      <div class="modal-title-block">
        <h3>添加 MCP 服务</h3>
        <p>从 Registry 搜索安装，或手动填写连接参数。</p>
      </div>
      <Button class="add-service-close" variant="ghost" size="icon" aria-label="收起" @click="emit('close')">
        <IconClose :size="16" />
      </Button>
    </div>
    <!-- 注：.add-subnav 是「添加服务」面板内的次级方式切换（手动 vs Registry），
         不是页面级 Tab；用局部 pill 切换更贴合折叠面板语境。 -->
    <div class="add-subnav">
      <button type="button" class="add-subnav-btn" :class="{ 'add-subnav-btn--active': addMode === 'manual' }" @click="emit('update:addMode', 'manual')">
        <IconPlus :size="15" />
        手动配置
      </button>
      <button type="button" class="add-subnav-btn" :class="{ 'add-subnav-btn--active': addMode === 'registry' }" @click="emit('update:addMode', 'registry')">
        <IconSearch :size="15" />
        从 Registry 搜索
      </button>
    </div>

    <div v-if="addMode === 'manual'" class="add-pane">
      <div class="manual-install-form">
        <div class="form-grid">
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
        <div class="form-grid">
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
              <div class="registry-card-meta"><code>{{ item.name }}</code><span class="version-tag">v{{ item.version }}</span><Badge v-if="item.latest" variant="success">Latest</Badge></div>
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
</template>

<script setup>
// 「添加 MCP 服务」折叠面板：手动配置 + Registry 搜索安装两种方式。
import CustomSelect from '../ui/CustomSelect.vue';
import NumberInput from '../NumberInput.vue';
import EntityListLayout from '../admin/EntityListLayout.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import IconCheck from '../icons/IconCheck.vue';
import IconClose from '../icons/IconClose.vue';
import IconDownload from '../icons/IconDownload.vue';
import IconPlus from '../icons/IconPlus.vue';
import IconSearch from '../icons/IconSearch.vue';
import IconWarning from '../icons/IconWarning.vue';

defineProps({
  addMode: { type: String, required: true },
  installForm: { type: Object, required: true },
  transportOptions: { type: Array, default: () => [] },
  riskOptions: { type: Array, default: () => [] },
  installing: { type: Boolean, default: false },
  registrySearch: { type: Object, required: true },
  loadingRegistryResults: { type: Boolean, default: false },
  registryResults: { type: Array, default: () => [] },
  installingRegistry: { type: Boolean, default: false },
  registryNextCursor: { default: null },
  loadingMoreRegistry: { type: Boolean, default: false },
  resetInstallForm: { type: Function, required: true },
  submitManualInstall: { type: Function, required: true },
  searchRegistryServers: { type: Function, required: true },
  loadMoreRegistryServers: { type: Function, required: true },
  handleRegistryInstall: { type: Function, required: true },
  openRegistryInstallDialog: { type: Function, required: true },
  quickInstallButtonText: { type: Function, required: true },
  firstUnsupportedReason: { type: Function, required: true },
  openExternalLink: { type: Function, required: true },
});

const emit = defineEmits(['close', 'update:addMode']);
</script>
