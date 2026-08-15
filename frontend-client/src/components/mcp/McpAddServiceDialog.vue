<!-- eslint-disable vue/no-mutating-props -- installForm/registrySearch 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="open" @update:open="(v) => emit('update:open', v)">
    <DialogContent class="max-w-[880px]">
      <DialogHeader>
        <DialogTitle>添加 MCP 服务</DialogTitle>
        <DialogDescription>从 Registry 搜索安装，或手动填写连接参数。</DialogDescription>
      </DialogHeader>

      <!-- 方式切换：全项目统一的胶囊分段控件（wb-workspace-tabbar 容器 + SegmentedControl） -->
      <div class="wb-workspace-tabbar mcp-add-tabbar">
        <SegmentedControl
          :model-value="addMode"
          :options="addModeOptions"
          aria-label="添加方式"
          @update:model-value="(v) => emit('update:addMode', v)"
        />
      </div>

      <div v-if="addMode === 'manual'" class="dialog-form">
        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>基本信息</h3><p>服务的唯一标识与前端展示名称。</p></div>
          <FieldGroup class="form-grid">
            <Field :data-invalid="!!errorFor('server_name')">
              <FieldLabel for="mcp-add-name">服务名称 <span class="required">*</span></FieldLabel>
              <Input id="mcp-add-name" v-model.trim="installForm.server_name" :aria-invalid="!!errorFor('server_name')" placeholder="唯一标识，如 my_server" @blur="markTouched('server_name')" />
              <FieldError v-if="errorFor('server_name')">{{ errorFor('server_name') }}</FieldError>
            </Field>
            <Field>
              <FieldLabel for="mcp-add-display-name">显示名称</FieldLabel>
              <Input id="mcp-add-display-name" v-model.trim="installForm.display_name" placeholder="前端展示名称，留空用服务名称" />
            </Field>
          </FieldGroup>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>连接配置</h3><p>选择传输方式，并填写对应的连接参数。</p></div>
          <div class="transport-card-grid" role="radiogroup" aria-label="传输方式">
            <button
              v-for="card in transportCards"
              :key="card.value"
              type="button"
              class="transport-card"
              :class="{ 'transport-card--active': installForm.transport === card.value }"
              role="radio"
              :aria-checked="installForm.transport === card.value"
              @click="installForm.transport = card.value"
            >
              <component :is="card.icon" :size="18" :stroke-width="1.8" class="transport-card__icon" />
              <span class="transport-card__label">{{ card.label }}</span>
              <span class="transport-card__desc">{{ card.desc }}</span>
              <IconCheck v-if="installForm.transport === card.value" :size="13" :stroke-width="3" class="transport-card__check" />
            </button>
          </div>

          <FieldGroup v-if="installForm.transport === 'stdio'" class="form-grid">
            <Field class="form-grid__full" :data-invalid="!!errorFor('command')">
              <FieldLabel for="mcp-add-command">命令 <span class="required">*</span></FieldLabel>
              <Input id="mcp-add-command" v-model.trim="installForm.command" :aria-invalid="!!errorFor('command')" placeholder="npx / uvx / python / node" @blur="markTouched('command')" />
              <FieldDescription>启动 MCP 服务的可执行命令。</FieldDescription>
              <FieldError v-if="errorFor('command')">{{ errorFor('command') }}</FieldError>
            </Field>
            <Field :data-invalid="!!errorFor('argsJson')">
              <FieldLabel for="mcp-add-args">参数</FieldLabel>
              <Textarea id="mcp-add-args" v-model="installForm.argsJson" rows="4" class="font-mono-input" :aria-invalid="!!errorFor('argsJson')" placeholder='["-y", "@scope/package"]' @blur="markTouched('argsJson')" />
              <FieldDescription>JSON 数组格式，作为命令启动参数。</FieldDescription>
              <FieldError v-if="errorFor('argsJson')">{{ errorFor('argsJson') }}</FieldError>
            </Field>
            <Field :data-invalid="!!errorFor('envJson')">
              <FieldLabel for="mcp-add-env">环境变量</FieldLabel>
              <Textarea id="mcp-add-env" v-model="installForm.envJson" rows="4" class="font-mono-input" :aria-invalid="!!errorFor('envJson')" placeholder='{"API_KEY": "..."}' @blur="markTouched('envJson')" />
              <FieldDescription>JSON 对象，合并到 MCP 进程环境。</FieldDescription>
              <FieldError v-if="errorFor('envJson')">{{ errorFor('envJson') }}</FieldError>
            </Field>
          </FieldGroup>
          <FieldGroup v-else class="form-grid">
            <Field class="form-grid__full" :data-invalid="!!errorFor('url')">
              <FieldLabel for="mcp-add-url">URL <span class="required">*</span></FieldLabel>
              <Input id="mcp-add-url" v-model.trim="installForm.url" type="url" :aria-invalid="!!errorFor('url')" placeholder="https://example.com/mcp" @blur="markTouched('url')" />
              <FieldDescription>远程 MCP 服务端点。</FieldDescription>
              <FieldError v-if="errorFor('url')">{{ errorFor('url') }}</FieldError>
            </Field>
            <Field class="form-grid__full" :data-invalid="!!errorFor('headersJson')">
              <FieldLabel for="mcp-add-headers">Headers</FieldLabel>
              <Textarea id="mcp-add-headers" v-model="installForm.headersJson" rows="4" class="font-mono-input" :aria-invalid="!!errorFor('headersJson')" placeholder='{"Authorization": "Bearer ..."}' @blur="markTouched('headersJson')" />
              <FieldDescription>JSON 对象，作为请求头发送。</FieldDescription>
              <FieldError v-if="errorFor('headersJson')">{{ errorFor('headersJson') }}</FieldError>
            </Field>
          </FieldGroup>
        </section>

        <section class="dialog-form-section">
          <button type="button" class="advanced-toggle" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
            <IconChevronDown :size="15" class="advanced-toggle__chevron" :class="{ 'advanced-toggle__chevron--open': advancedOpen }" />
            <span class="advanced-toggle__title">高级设置</span>
            <span class="advanced-toggle__hint">超时、风险等级与运行开关</span>
          </button>
          <div v-show="advancedOpen" class="advanced-body">
            <FieldGroup class="form-grid">
              <Field>
                <FieldLabel>超时秒数</FieldLabel>
                <NumberInput :model-value="installForm.timeout" :min="1" :max="300" @update:model-value="installForm.timeout = $event" />
              </Field>
              <Field>
                <FieldLabel>风险等级</FieldLabel>
                <CustomSelect :model-value="installForm.risk_level" :options="riskOptions" @update:model-value="installForm.risk_level = $event" />
                <FieldDescription>工具级风险覆盖：连接后在「工具」列表里按工具单独调整。</FieldDescription>
              </Field>
            </FieldGroup>
            <FieldGroup class="switch-fields">
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="installForm.enabled" />
                  <FieldContent>
                    <FieldTitle>启用服务</FieldTitle>
                    <FieldDescription>禁用后服务不可连接，配置仍然保留。</FieldDescription>
                  </FieldContent>
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="installForm.auto_connect" />
                  <FieldContent>
                    <FieldTitle>自动连接</FieldTitle>
                    <FieldDescription>应用启动或有会话请求时自动建立连接。</FieldDescription>
                  </FieldContent>
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="installForm.trusted" />
                  <FieldContent>
                    <FieldTitle>受信任</FieldTitle>
                    <FieldDescription>信任后工具 annotations 可驱动并发；未信任服务保守串行执行。</FieldDescription>
                  </FieldContent>
                </FieldLabel>
              </Field>
            </FieldGroup>
          </div>
        </section>
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
              <div class="registry-card-icon"><Package :size="16" :stroke-width="1.8" /></div>
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

      <DialogFooter v-if="addMode === 'manual'">
        <Button variant="outline" size="sm" :disabled="installing" @click="onReset">重置</Button>
        <Button variant="default" size="sm" :disabled="installing || hasBlockingErrors" @click="onSubmit">
          <Spinner v-if="installing" data-icon="inline-start" />
          <IconDownload v-else :size="15" />
          <span>{{ installing ? '安装中...' : '安装服务' }}</span>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// 「添加 MCP 服务」弹窗：手动配置 + Registry 搜索安装两种方式。
// 手动配置内联实时校验（blur 或首次提交后展示错误）；校验通过后才会调用父级 submitManualInstall。
import { computed, reactive, ref } from 'vue';
import { Globe, Package, Rss, Terminal } from 'lucide-vue-next';
import CustomSelect from '../ui/CustomSelect.vue';
import NumberInput from '../NumberInput.vue';
import EntityListLayout from '../admin/EntityListLayout.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Field, FieldContent, FieldDescription, FieldError, FieldGroup,
  FieldLabel, FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Spinner } from '../ui/spinner';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';
import SegmentedControl from '../SegmentedControl.vue';
import IconCheck from '../icons/IconCheck.vue';
import IconChevronDown from '../icons/IconChevronDown.vue';
import IconClose from '../icons/IconClose.vue';
import IconDownload from '../icons/IconDownload.vue';
import IconPlus from '../icons/IconPlus.vue';
import IconSearch from '../icons/IconSearch.vue';
import IconWarning from '../icons/IconWarning.vue';

const props = defineProps({
  open: { type: Boolean, default: false },
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

const emit = defineEmits(['update:open', 'update:addMode']);

const advancedOpen = ref(false);

const addModeOptions = [
  { value: 'manual', label: '手动配置', icon: IconPlus },
  { value: 'registry', label: '从 Registry 搜索', icon: IconSearch },
];

// 传输方式卡片：图标/短标签/说明按已知值定制，其余回退到 transportOptions 的 label。
const TRANSPORT_CARD_META = {
  stdio: { icon: Terminal, label: 'stdio', desc: '本地进程' },
  sse: { icon: Rss, label: 'SSE', desc: '远程事件流' },
  streamable_http: { icon: Globe, label: 'Streamable HTTP', desc: '远程 HTTP' },
};
const transportCards = computed(() => props.transportOptions.map((o) => ({
  value: o.value,
  ...(TRANSPORT_CARD_META[o.value] || { icon: Globe, label: o.label, desc: '' }),
})));

// ---- 内联实时校验 ----
const touched = reactive(new Set());
const submitAttempted = ref(false);
function markTouched(key) { touched.add(key); }

function jsonError(text, expect, example) {
  if (!text || !text.trim()) return '';
  try {
    const parsed = JSON.parse(text);
    if (expect === 'array' && !Array.isArray(parsed)) return `需为 JSON 数组，如 ${example}`;
    if (expect === 'object' && (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null)) return `需为 JSON 对象，如 ${example}`;
    return '';
  } catch {
    return `JSON 格式不正确，如 ${example}`;
  }
}

const formErrors = computed(() => {
  const f = props.installForm;
  const isStdio = f.transport === 'stdio';
  return {
    server_name: f.server_name ? '' : '请填写服务名称',
    command: !isStdio || f.command ? '' : '请填写启动命令',
    url: isStdio ? '' : (f.url ? (/^https?:\/\//i.test(f.url) ? '' : 'URL 需以 http:// 或 https:// 开头') : '请填写 URL'),
    argsJson: isStdio ? jsonError(f.argsJson, 'array', '["-y", "@scope/package"]') : '',
    envJson: isStdio ? jsonError(f.envJson, 'object', '{"API_KEY": "..."}') : '',
    headersJson: isStdio ? '' : jsonError(f.headersJson, 'object', '{"Authorization": "Bearer ..."}'),
  };
});
const hasBlockingErrors = computed(() => Object.values(formErrors.value).some(Boolean));
function errorFor(key) {
  return (submitAttempted.value || touched.has(key)) ? formErrors.value[key] : '';
}

function onSubmit() {
  submitAttempted.value = true;
  if (hasBlockingErrors.value) return;
  props.submitManualInstall();
}
function onReset() {
  touched.clear();
  submitAttempted.value = false;
  props.resetInstallForm();
}
</script>
