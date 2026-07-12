<template>
  <PageLayout title="Widget 凭证控制台" subtitle="管理浏览器嵌入 key、服务端 secret 与来源白名单">
    <template #header-actions><Button size="sm" @click="openCreate">创建应用</Button></template>
    <KpiCards :items="kpis" />
    <details class="guide"><summary>publishable key 集成指引</summary><pre>{{ integrationExample('wid_pk_你的key') }}</pre></details>
    <EntityListLayout title="Widget 应用" description="publishable key 可公开放在宿主页；secret 只在创建或轮换后展示一次。" :loading="loading" :error="error" :empty="apps.length === 0" empty-title="暂无 Widget 应用" empty-hint="创建应用后即可按 Origin 白名单嵌入" @retry="refresh">
      <div class="app-list">
        <article v-for="item in apps" :key="item.app_key" class="app-card">
          <div><strong>{{ item.display_name }}</strong><span class="status">{{ item.revoked_at ? '已吊销' : '活跃' }}</span></div>
          <div class="key-line"><code>{{ item.app_key }}</code><Button variant="ghost" size="sm" title="前端嵌入用这个，可公开" @click="copy(item.app_key)">复制</Button></div>
          <p>{{ item.allowed_origins.length ? item.allowed_origins.join('、') : '未配置 Origin，publishable key 请求将被拒绝' }}</p>
          <div class="actions"><Button variant="outline" size="sm" :disabled="!!item.revoked_at" @click="openEdit(item)">编辑</Button><Button variant="outline" size="sm" :disabled="!!item.revoked_at" @click="rotate(item)">轮换 secret</Button><Button variant="outline" size="sm" @click="openAudit(item)">审计</Button><Button variant="destructive" size="sm" :disabled="!!item.revoked_at" @click="revoke(item)">吊销</Button></div>
        </article>
      </div>
    </EntityListLayout>

    <Dialog :open="formOpen" @update:open="formOpen = $event"><DialogContent><DialogHeader><DialogTitle>{{ editing ? '编辑应用' : '创建应用' }}</DialogTitle><DialogDescription>每行填写一个完整 Origin，例如 https://example.com。</DialogDescription></DialogHeader><label>名称</label><Input v-model="form.display_name" /><label>允许的 Origins</label><Textarea v-model="form.origins" rows="6" /><p v-if="formError" class="error">{{ formError }}</p><DialogFooter><Button variant="outline" @click="formOpen=false">取消</Button><Button :disabled="saving" @click="submit">保存</Button></DialogFooter></DialogContent></Dialog>
    <Dialog :open="!!secretResult" @update:open="v => { if (!v) secretResult = null }"><DialogContent><DialogHeader><DialogTitle>请立即保存 secret</DialogTitle><DialogDescription>明文只展示这一次，关闭后无法找回。</DialogDescription></DialogHeader><label>app_key</label><div class="key-line"><code>{{ secretResult?.app_key }}</code><Button variant="ghost" size="sm" @click="copy(secretResult?.app_key)">复制</Button></div><label>secret</label><div class="key-line"><code>{{ secretResult?.secret }}</code><Button variant="ghost" size="sm" @click="copy(secretResult?.secret)">复制</Button></div><pre>{{ secretResult ? integrationExample(secretResult.app_key) : '' }}</pre></DialogContent></Dialog>
    <Sheet :open="auditOpen" @update:open="auditOpen = $event"><SheetContent><SheetHeader><SheetTitle>审计时间线</SheetTitle><SheetDescription>{{ auditApp?.display_name }}</SheetDescription></SheetHeader><ol class="timeline"><li v-for="entry in audit" :key="entry.id"><strong>{{ entry.action }}</strong><span>{{ entry.created_at }} · {{ entry.actor }}</span><pre v-if="entry.detail">{{ JSON.stringify(entry.detail, null, 2) }}</pre></li></ol></SheetContent></Sheet>
  </PageLayout>
</template>

<script setup>
import { computed, reactive, ref } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import EntityListLayout from '../components/admin/EntityListLayout.vue';
import { Button } from '../components/ui/button'; import { Input } from '../components/ui/input'; import { Textarea } from '../components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../components/ui/sheet';
import { useAsyncAction } from '../composables/useAsyncAction.js'; import { useEntityList } from '../composables/useEntityList.js';
import { createWidgetApp, listWidgetApps, updateWidgetApp, rotateWidgetSecret, revokeWidgetApp, listWidgetAudit } from '../api/widgetApps.js';

const { items: apps, loading, error, refresh } = useEntityList(listWidgetApps);
const formOpen = ref(false), editing = ref(null), secretResult = ref(null), formError = ref(''), auditOpen = ref(false), auditApp = ref(null), audit = ref([]);
const form = reactive({ display_name: '', origins: '' });
const { run: save, loading: saving } = useAsyncAction(async () => { const allowed_origins = parseOrigins(form.origins); return editing.value ? updateWidgetApp(editing.value.app_key, { display_name: form.display_name, allowed_origins }) : createWidgetApp({ display_name: form.display_name, allowed_origins }); }, { successMessage: '保存成功' });
const kpis = computed(() => { const week = Date.now() - 7 * 86400000; return [{ label: '应用总数', value: apps.value.length }, { label: '活跃', value: apps.value.filter(x => !x.revoked_at).length }, { label: '吊销', value: apps.value.filter(x => x.revoked_at).length }, { label: '本周操作', value: audit.value.filter(x => Date.parse(x.created_at) >= week).length }]; });
function openCreate(){ editing.value=null; Object.assign(form,{display_name:'',origins:''}); formError.value=''; formOpen.value=true; }
function openEdit(item){ editing.value=item; Object.assign(form,{display_name:item.display_name,origins:item.allowed_origins.join('\n')}); formError.value=''; formOpen.value=true; }
function parseOrigins(text){ const values=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean); const invalid=values.find(x=>!/^https?:\/\/[^/]+(?::\d+)?$/.test(x)); if(invalid) throw new Error(`Origin 格式无效：${invalid}`); return values; }
async function submit(){ formError.value=''; try { if(!form.display_name.trim()) throw new Error('名称不能为空'); const result=await save(); if(!result)return; formOpen.value=false; if(!editing.value) secretResult.value=result; await refresh(); } catch(e){ formError.value=e.message; } }
async function rotate(item){ const result=await rotateWidgetSecret(item.app_key); secretResult.value=result; await refresh(); }
async function revoke(item){ if(!confirm(`确认吊销 ${item.display_name}？`))return; await revokeWidgetApp(item.app_key); await refresh(); }
async function openAudit(item){ auditApp.value=item; audit.value=await listWidgetAudit(item.app_key); auditOpen.value=true; }
async function copy(value){ if(value) await navigator.clipboard.writeText(value); }
function integrationExample(key){ return `RagSystemWidget.mount({\n  backendBase: 'https://api.example.com',\n  publishableKey: '${key}'\n})`; }
</script>

<style scoped>
.guide,.app-card{border:1px solid var(--border);border-radius:var(--radius);padding:1rem}.guide{margin-bottom:1rem}.app-list{display:grid;gap:.75rem}.app-card{display:grid;gap:.75rem}.app-card>div:first-child{display:flex;justify-content:space-between}.key-line,.actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.key-line code{overflow-wrap:anywhere}.status{color:var(--muted-foreground)}pre{overflow:auto;background:var(--muted);padding:.75rem;border-radius:var(--radius)}.error{color:var(--destructive)}.timeline{display:grid;gap:1rem;padding:1rem}.timeline li{display:grid;gap:.25rem}.timeline span{color:var(--muted-foreground);font-size:.875rem}
</style>
