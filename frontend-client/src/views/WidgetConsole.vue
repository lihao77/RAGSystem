<template>
  <PageLayout title="Widget 凭证控制台" subtitle="管理浏览器嵌入 key、服务端 secret 与来源白名单">
    <template #header-actions>
      <Button size="sm" @click="openCreate"><Plus :size="14" />创建应用</Button>
    </template>

    <KpiCards :items="kpis" />

    <details class="guide">
      <summary><ChevronRight :size="13" class="guide__chevron" /><BookOpen :size="14" />publishable key 集成指引</summary>
      <div class="guide__body">
        <pre>{{ integrationExample('wid_pk_你的key') }}</pre>
      </div>
    </details>

    <EntityListLayout
      title="Widget 应用"
      description="publishable key 可公开放在宿主页；secret 只在创建或轮换后展示一次。"
      :loading="loading"
      :error="error"
      :empty="apps.length === 0"
      empty-title="暂无 Widget 应用"
      empty-hint="创建应用后即可按 Origin 白名单嵌入"
      @retry="refresh"
    >
      <div class="app-list">
        <article
          v-for="(item, index) in apps"
          :key="item.app_key"
          class="app-card"
          :class="{ 'app-card--revoked': item.revoked_at }"
          :style="{ '--i': index }"
        >
          <header class="app-card__header">
            <strong>{{ item.display_name }}</strong>
            <Badge :variant="item.revoked_at ? 'outline' : 'success'">{{ item.revoked_at ? '已吊销' : '活跃' }}</Badge>
          </header>

          <div class="key-line">
            <KeyRound :size="13" class="key-line__icon" />
            <code class="key-chip">{{ item.app_key }}</code>
            <Button variant="ghost" size="sm" class="copy-btn" :class="{ 'copy-btn--done': copiedKey === item.app_key }" title="前端嵌入用这个，可公开" @click="copy(item.app_key)">
              <component :is="copiedKey === item.app_key ? Check : Copy" :size="13" />{{ copiedKey === item.app_key ? '已复制' : '复制' }}
            </Button>
          </div>

          <div class="origins">
            <template v-if="item.allowed_origins.length">
              <p v-for="origin in item.allowed_origins" :key="origin" class="meta-row">
                <Globe :size="13" />{{ origin }}
              </p>
            </template>
            <p v-else class="meta-row meta-row--warning">
              <TriangleAlert :size="13" />未配置 Origin，publishable key 请求将被拒绝
            </p>
          </div>

          <div class="actions">
            <Button variant="outline" size="sm" :disabled="!!item.revoked_at" :title="item.revoked_at ? '已吊销的应用不可编辑' : '编辑'" @click="openEdit(item)">编辑</Button>
            <Button variant="outline" size="sm" :disabled="!!item.revoked_at" :title="item.revoked_at ? '已吊销的应用不可轮换' : '轮换 secret'" @click="requestRotate(item)">轮换 secret</Button>
            <Button variant="outline" size="sm" @click="openAudit(item)">审计</Button>
            <Button variant="destructive" size="sm" :disabled="!!item.revoked_at" :title="item.revoked_at ? '应用已吊销' : '吊销'" @click="requestRevoke(item)">吊销</Button>
          </div>
        </article>
      </div>
    </EntityListLayout>

    <Dialog :open="formOpen" @update:open="formOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ editing ? '编辑应用' : '创建应用' }}</DialogTitle>
          <DialogDescription>每行填写一个完整 Origin，例如 https://example.com。</DialogDescription>
        </DialogHeader>
        <label>名称</label>
        <Input v-model="form.display_name" />
        <label>允许的 Origins</label>
        <Textarea v-model="form.origins" rows="6" />
        <p v-if="formError" class="error">{{ formError }}</p>
        <DialogFooter>
          <Button variant="outline" @click="formOpen = false">取消</Button>
          <Button :disabled="saving" @click="submit">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="!!secretResult" @update:open="v => { if (!v) secretResult = null }">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>请立即保存 secret</DialogTitle>
          <DialogDescription>明文只展示这一次，关闭后无法找回。</DialogDescription>
        </DialogHeader>
        <label>app_key</label>
        <div class="key-line">
          <code class="key-chip">{{ secretResult?.app_key }}</code>
          <Button variant="ghost" size="sm" class="copy-btn" :class="{ 'copy-btn--done': copiedKey === secretResult?.app_key }" @click="copy(secretResult?.app_key)">
            <component :is="copiedKey === secretResult?.app_key ? Check : Copy" :size="13" />{{ copiedKey === secretResult?.app_key ? '已复制' : '复制' }}
          </Button>
        </div>
        <label>secret</label>
        <div class="key-line">
          <code class="key-chip">{{ secretResult?.secret }}</code>
          <Button variant="ghost" size="sm" class="copy-btn" :class="{ 'copy-btn--done': copiedKey === secretResult?.secret }" @click="copy(secretResult?.secret)">
            <component :is="copiedKey === secretResult?.secret ? Check : Copy" :size="13" />{{ copiedKey === secretResult?.secret ? '已复制' : '复制' }}
          </Button>
        </div>
        <pre>{{ secretResult ? integrationExample(secretResult.app_key) : '' }}</pre>
      </DialogContent>
    </Dialog>

    <Sheet :open="auditOpen" @update:open="auditOpen = $event">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>审计时间线</SheetTitle>
          <SheetDescription>{{ auditApp?.display_name }}</SheetDescription>
        </SheetHeader>
        <ol class="timeline">
          <li v-for="entry in audit" :key="entry.id">
            <strong>{{ entry.action }}</strong>
            <span>{{ formatAuditTime(entry.created_at) }} · {{ entry.actor }}</span>
            <pre v-if="entry.detail">{{ JSON.stringify(entry.detail, null, 2) }}</pre>
          </li>
        </ol>
      </SheetContent>
    </Sheet>

    <AlertDialog :open="!!confirmState" @update:open="v => { if (!v) confirmState = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ confirmState?.action === 'revoke' ? '吊销应用' : '轮换 secret' }}</AlertDialogTitle>
          <AlertDialogDescription>
            <template v-if="confirmState?.action === 'revoke'">
              吊销后 {{ confirmState?.app?.display_name }} 的 publishable key 与 secret 将立即失效，嵌入的 Widget 会停止工作。此操作不可撤销。
            </template>
            <template v-else>
              轮换后 {{ confirmState?.app?.display_name }} 的旧 secret 立即失效，使用旧 secret 的服务端调用将失败。新 secret 只展示一次。
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="confirmBusy">取消</AlertDialogCancel>
          <AlertDialogAction :disabled="confirmBusy" @click="runConfirm">
            {{ confirmState?.action === 'revoke' ? '确认吊销' : '确认轮换' }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </PageLayout>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import { BookOpen, Check, ChevronRight, CircleCheck, CircleSlash, Copy, Globe, KeyRound, LayoutGrid, Plus, TriangleAlert } from 'lucide-vue-next';
import PageLayout from '../components/PageLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useEntityList } from '../composables/useEntityList.js';
import { useToast } from '../composables/useToast.js';
import { createWidgetApp, listWidgetApps, updateWidgetApp, rotateWidgetSecret, revokeWidgetApp, listWidgetAudit } from '../api/widgetApps.js';

const { items: apps, loading, error, refresh } = useEntityList(listWidgetApps);
const toast = useToast();
const formOpen = ref(false), editing = ref(null), secretResult = ref(null), formError = ref(''), auditOpen = ref(false), auditApp = ref(null), audit = ref([]);
const copiedKey = ref('');
let copiedTimer = 0;
const form = reactive({ display_name: '', origins: '' });
const confirmState = ref(null); // { action: 'rotate' | 'revoke', app }
const confirmBusy = ref(false);
const { run: save, loading: saving } = useAsyncAction(async () => { const allowed_origins = parseOrigins(form.origins); return editing.value ? updateWidgetApp(editing.value.app_key, { display_name: form.display_name, allowed_origins }) : createWidgetApp({ display_name: form.display_name, allowed_origins }); }, { successMessage: '保存成功' });
const kpis = computed(() => [
  { key: 'total', label: '应用总数', value: apps.value.length, icon: LayoutGrid },
  { key: 'active', label: '活跃', value: apps.value.filter(x => !x.revoked_at).length, icon: CircleCheck },
  { key: 'revoked', label: '已吊销', value: apps.value.filter(x => x.revoked_at).length, icon: CircleSlash },
  { key: 'no-origin', label: '缺 Origin 白名单', value: apps.value.filter(x => !x.revoked_at && !x.allowed_origins?.length).length, icon: TriangleAlert, tone: 'warning' },
]);
function openCreate(){ editing.value=null; Object.assign(form,{display_name:'',origins:''}); formError.value=''; formOpen.value=true; }
function openEdit(item){ editing.value=item; Object.assign(form,{display_name:item.display_name,origins:item.allowed_origins.join('\n')}); formError.value=''; formOpen.value=true; }
function parseOrigins(text){ const values=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); const invalid=values.find(x=>!/^https?:\/\/[^/]+(?::\d+)?$/.test(x)); if(invalid) throw new Error(`Origin 格式无效：${invalid}`); return values; }
async function submit(){ formError.value=''; try { if(!form.display_name.trim()) throw new Error('名称不能为空'); const result=await save(); if(!result)return; formOpen.value=false; if(!editing.value) secretResult.value=result; await refresh(); } catch(e){ formError.value=e.message; } }
function requestRotate(item){ confirmState.value = { action: 'rotate', app: item }; }
function requestRevoke(item){ confirmState.value = { action: 'revoke', app: item }; }
async function runConfirm(){
  const state = confirmState.value;
  if (!state || confirmBusy.value) return;
  confirmBusy.value = true;
  try {
    if (state.action === 'revoke') {
      await revokeWidgetApp(state.app.app_key);
      toast.success(`已吊销 ${state.app.display_name}`);
    } else {
      const result = await rotateWidgetSecret(state.app.app_key);
      secretResult.value = result;
      toast.success('secret 已轮换，请立即保存新值');
    }
    confirmState.value = null;
    await refresh();
  } catch (e) {
    toast.error(e?.message || '操作失败');
  } finally {
    confirmBusy.value = false;
  }
}
async function openAudit(item){ auditApp.value=item; audit.value=await listWidgetAudit(item.app_key); auditOpen.value=true; }
async function copy(value){ if(!value) return; await navigator.clipboard.writeText(value); copiedKey.value=value; clearTimeout(copiedTimer); copiedTimer=setTimeout(()=>{ copiedKey.value=''; },1400); }
function integrationExample(key){ return `RagSystemWidget.mount({\n  backendBase: 'https://api.example.com',\n  publishableKey: '${key}'\n})`; }
function formatAuditTime(value){ const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
</script>

<style scoped>
/* ---- 集成指引：淡 accent 底 disclosure，grid-rows 实现平滑展开 ---- */
.guide {
  display: grid;
  grid-template-rows: auto 0fr;
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-lg);
  background: var(--color-accent-bg);
  padding: var(--spacing-sm) var(--spacing-md);
  transition: grid-template-rows var(--transition-normal);
}

.guide[open] {
  grid-template-rows: auto 1fr;
}

/* 覆盖 UA 对未展开 details 子元素的隐藏，使收起过程也能过渡 */
.guide__body {
  display: block;
  overflow: hidden;
  min-height: 0;
}

.guide summary {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  user-select: none;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
}

.guide summary::-webkit-details-marker {
  display: none;
}

.guide summary:hover {
  color: var(--color-text-primary);
}

.guide__chevron {
  transition: transform var(--transition-fast);
}

.guide[open] .guide__chevron {
  transform: rotate(90deg);
}

.guide pre {
  margin-top: var(--spacing-sm);
}

/* ---- 应用卡片 ---- */
.app-list {
  display: grid;
  gap: var(--spacing-md);
}

.app-card {
  display: grid;
  gap: var(--spacing-sm);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--spacing-md);
  animation: widget-card-in var(--duration-base) var(--ease-out-expo) backwards;
  animation-delay: calc(var(--i, 0) * 55ms);
  transition: border-color var(--transition-fast);
}

@keyframes widget-card-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

.app-card:hover {
  border-color: var(--color-border-hover);
}

.app-card--revoked {
  opacity: 0.62;
}

.app-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  font-size: var(--font-size-base);
}

/* ---- 密钥行：等宽 chip + 复制 ---- */
.key-line {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
  min-width: 0;
}

.key-line__icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.key-chip {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  overflow-wrap: anywhere;
  min-width: 0;
}

/* ---- 元信息行（origin / 警告） ---- */
.origins {
  display: grid;
  gap: var(--spacing-xs);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.meta-row--warning {
  color: var(--color-warning);
}

/* ---- 复制按钮：成功态绿色 ---- */
.copy-btn {
  transition: color var(--transition-fast);
}

.copy-btn--done {
  color: var(--color-success);
}

.copy-btn--done:hover {
  color: var(--color-success);
}

/* ---- 操作区：顶部分隔，独立成行 ---- */
.actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
  border-top: 1px solid var(--color-border);
  padding-top: var(--spacing-sm);
}

/* ---- 代码块 / 错误 / 时间线 ---- */
pre {
  overflow: auto;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
  font-size: var(--font-size-xs);
}

.error {
  color: var(--color-error);
}

.timeline {
  display: grid;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
}

.timeline li {
  display: grid;
  gap: var(--spacing-xs);
}

.timeline span {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
</style>
