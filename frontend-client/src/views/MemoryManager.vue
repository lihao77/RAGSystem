<template>
  <PageLayout title="Memory 管理" subtitle="个人、共享与治理记录" mobile-title="Memory">
    <div class="memory-manager">
      <div class="section-toolbar">
        <div class="toolbar-left">
          <UiTabs v-model="activeView" :tabs="views" />
        </div>
        <div class="toolbar-right">
          <Input v-model="searchQuery" class="memory-search-input" placeholder="搜索名称或内容" aria-label="搜索 Memory" />
          <Select v-model="scopeFilter">
            <SelectTrigger class="scope-select" aria-label="Scope 筛选">
              <SelectValue placeholder="全部 Scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem v-for="option in scopeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="secondary" size="icon" :disabled="loading" title="刷新" aria-label="刷新" @click="loadCurrentView">
            <RefreshCw data-icon :class="cn({ 'animate-spin': loading })" />
          </Button>
        </div>
      </div>

      <div class="data-table-wrapper glass-card">
        <div v-if="loading" class="g-table-loading">
          <div class="g-skeleton-rows" aria-busy="true">
            <div v-for="n in 5" :key="n" class="g-skeleton-row">
              <div class="g-skeleton-bar g-skeleton-bar--title" />
              <div class="g-skeleton-bar g-skeleton-bar--sub" />
            </div>
          </div>
        </div>
        <div v-else-if="error" class="empty-state adm-state adm-state--empty">
          <p>{{ error }}</p>
          <Button variant="outline" size="sm" @click="loadCurrentView">重试</Button>
        </div>
        <div v-else-if="filteredItems.length === 0" class="empty-state adm-state adm-state--empty">
          <p>暂无记录</p>
        </div>
        <Table v-else class="memory-table">
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead v-if="showActions" class="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="item in filteredItems" :key="`${itemKind(item)}-${item.id}`">
                <TableCell class="memory-name-cell">
                  <div class="flex flex-col gap-1">
                    <div class="flex items-center gap-2">
                      <span class="truncate font-medium" :title="item.name">{{ item.name || '未命名 Memory' }}</span>
                      <UiBadge v-if="isCandidate(item)" size="sm" tone="neutral">{{ operationLabel(item.operation) }}</UiBadge>
                    </div>
                    <span class="memory-description" :title="item.description || item.content">
                      {{ item.description || item.content || '-' }}
                    </span>
                  </div>
                </TableCell>
                <TableCell><UiBadge size="sm" :tone="scopeTone(scopeOf(item))">{{ scopeOf(item) }}</UiBadge></TableCell>
                <TableCell>{{ typeLabel(item.memory_type) }}</TableCell>
                <TableCell><UiBadge class="status-badge" size="sm" :tone="statusTone(item.status)">{{ statusLabel(item.status) }}</UiBadge></TableCell>
                <TableCell class="cell-secondary memory-time-cell">{{ formatDate(item.updated_at || item.created_at) }}</TableCell>
                <TableCell v-if="showActions" class="cell-actions">
                  <div class="row-actions">
                    <template v-if="!isCandidate(item) && (activeView === 'mine' || activeView === 'shared')">
                      <Button
                        variant="action-neutral"
                        size="action"
                        title="查看详情"
                        aria-label="查看详情"
                        @click="openDetails(item)"
                      >
                        <Eye data-icon />
                      </Button>
                      <Button
                        v-if="activeView === 'mine' || canReview"
                        variant="action-warning"
                        size="action"
                        :title="activeView === 'shared' ? '发起归档申请' : '归档'"
                        :aria-label="activeView === 'shared' ? '发起归档申请' : '归档'"
                        :disabled="busyId === item.id"
                        @click="archiveEntry(item)"
                      >
                        <Archive data-icon />
                      </Button>
                    </template>
                    <template v-if="activeView === 'pending' && isCandidate(item) && item.status === 'candidate'">
                      <Button
                        v-if="isOwnedByCurrentUser(item)"
                        variant="action-neutral"
                        size="action"
                        title="编辑"
                        aria-label="编辑"
                        @click="openEdit(item)"
                      >
                        <Pencil data-icon />
                      </Button>
                      <Button
                        v-if="isOwnedByCurrentUser(item)"
                        variant="action-warning"
                        size="action"
                        title="撤回"
                        aria-label="撤回"
                        :disabled="busyId === item.id"
                        @click="withdraw(item)"
                      >
                        <Undo2 data-icon />
                      </Button>
                      <Button
                        v-if="canReview"
                        variant="action-success"
                        size="action"
                        title="审核"
                        aria-label="审核"
                        @click="openReview(item)"
                      >
                        <ClipboardCheck data-icon />
                      </Button>
                    </template>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        <div v-if="!loading && !error && filteredItems.length > 0" class="table-footer">
          <span>共 {{ filteredItems.length }} 条</span>
          <span v-if="total > items.length">已加载 {{ items.length }} / {{ total }}</span>
        </div>
      </div>
    </div>

    <Dialog :open="editOpen" @update:open="editOpen = $event">
      <DialogContent class="max-w-[620px]">
        <form class="flex flex-col gap-5" @submit.prevent="saveCandidate">
          <DialogHeader>
            <DialogTitle>编辑候选 Memory</DialogTitle>
            <DialogDescription>{{ scopeOf(activeItem) }} · {{ typeLabel(activeItem?.memory_type) }}</DialogDescription>
          </DialogHeader>
          <div class="flex flex-col gap-2">
            <label for="memory-name" class="text-sm font-medium">名称</label>
            <Input id="memory-name" v-model="editForm.name" required />
          </div>
          <div class="flex flex-col gap-2">
            <label for="memory-description" class="text-sm font-medium">描述</label>
            <Input id="memory-description" v-model="editForm.description" />
          </div>
          <div class="flex flex-col gap-2">
            <label for="memory-content" class="text-sm font-medium">内容</label>
            <Textarea id="memory-content" v-model="editForm.content" class="min-h-[180px]" required />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" :disabled="saving" @click="editOpen = false">取消</Button>
            <Button type="submit" :disabled="saving || !editForm.name.trim() || !editForm.content.trim()">
              {{ saving ? '保存中...' : '保存' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="detailsOpen" @update:open="detailsOpen = $event">
      <DialogContent class="max-w-[680px]">
        <DialogHeader>
          <DialogTitle>{{ activeItem?.name || 'Memory 详情' }}</DialogTitle>
          <DialogDescription>
            {{ scopeOf(activeItem) }} · {{ typeLabel(activeItem?.memory_type) }} · {{ statusLabel(activeItem?.status) }}
          </DialogDescription>
        </DialogHeader>
        <div class="flex max-h-[65vh] flex-col gap-5 overflow-y-auto pr-1">
          <section v-if="activeItem?.description" class="flex flex-col gap-2">
            <h3 class="text-sm font-medium">描述</h3>
            <p class="text-sm text-muted-foreground whitespace-pre-wrap">{{ activeItem.description }}</p>
          </section>
          <section class="flex flex-col gap-2">
            <h3 class="text-sm font-medium">内容</h3>
            <div class="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{{ activeItem?.content || '-' }}</div>
          </section>
          <section v-if="activeItem?.why" class="flex flex-col gap-2">
            <h3 class="text-sm font-medium">原因</h3>
            <p class="text-sm text-muted-foreground whitespace-pre-wrap">{{ activeItem.why }}</p>
          </section>
          <section v-if="activeItem?.how_to_apply" class="flex flex-col gap-2">
            <h3 class="text-sm font-medium">应用方式</h3>
            <p class="text-sm text-muted-foreground whitespace-pre-wrap">{{ activeItem.how_to_apply }}</p>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="detailsOpen = false">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="reviewOpen" @update:open="reviewOpen = $event">
      <DialogContent class="max-w-[620px]">
        <DialogHeader>
          <DialogTitle>审核候选 Memory</DialogTitle>
          <DialogDescription>{{ activeItem?.name }} · {{ scopeOf(activeItem) }}</DialogDescription>
        </DialogHeader>
        <div class="max-h-[260px] overflow-y-auto rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
          {{ activeItem?.content }}
        </div>
        <div class="flex flex-col gap-2">
          <label for="review-comment" class="text-sm font-medium">审核备注</label>
          <Textarea id="review-comment" v-model="reviewComment" class="min-h-[90px]" />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="reviewing" @click="reviewOpen = false">取消</Button>
          <Button variant="destructive" :disabled="reviewing" @click="reviewCandidate('reject')">
            <X data-icon="inline-start" />拒绝
          </Button>
          <Button :disabled="reviewing" @click="reviewCandidate('approve')">
            <Check data-icon="inline-start" />批准
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { Archive, Check, ClipboardCheck, Eye, Pencil, RefreshCw, Undo2, X } from 'lucide-vue-next';
import PageLayout from '../components/PageLayout.vue';
import { UiBadge, UiTabs } from '../components/ui';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import { useConfirm } from '../composables/useConfirm.js';
import { useToast } from '../composables/useToast.js';
import { useAuthStore } from '../stores/auth.js';
import { cn } from '../lib/utils.ts';
import {
  approveMemoryCandidate,
  archiveMemoryEntry,
  listAdminMemoryCandidates,
  listMemoryEntries,
  listMyMemoryCandidates,
  rejectMemoryCandidate,
  updateMemoryCandidate,
  withdrawMemoryCandidate,
} from '../api/memory.js';

const authStore = useAuthStore();
const toast = useToast();
const { confirm } = useConfirm();

const views = [
  { key: 'mine', label: '我的记忆' },
  { key: 'shared', label: '共享记忆' },
  { key: 'pending', label: '待审核' },
  { key: 'history', label: '历史' },
];
const scopeOptions = [
  { value: 'all', label: '全部 Scope' },
  { value: 'session', label: 'Session' },
  { value: 'user', label: 'User' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'team', label: 'Team' },
  { value: 'agent', label: 'Agent' },
];
const personalScopes = new Set(['session', 'user', 'workspace']);
const sharedScopes = new Set(['team', 'agent']);
const typeLabels = { preference: '偏好', constraint: '约束', goal: '目标', fact: '事实', profile: '档案' };
const statusLabels = { active: '活跃', archived: '已归档', candidate: '待审核', approved: '已批准', rejected: '已拒绝', withdrawn: '已撤回' };

const activeView = ref('mine');
const searchQuery = ref('');
const scopeFilter = ref('all');
const items = ref([]);
const total = ref(0);
const loading = ref(false);
const error = ref('');
const busyId = ref('');
const editOpen = ref(false);
const detailsOpen = ref(false);
const reviewOpen = ref(false);
const saving = ref(false);
const reviewing = ref(false);
const activeItem = ref(null);
const reviewComment = ref('');
const editForm = reactive({ name: '', description: '', content: '' });

const canReview = computed(() => authStore.role === 'admin' || authStore.role === 'owner');
const showActions = computed(() => activeView.value === 'mine' || activeView.value === 'shared' || activeView.value === 'pending');
const filteredItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  return items.value.filter((item) => {
    if (scopeFilter.value !== 'all' && scopeOf(item) !== scopeFilter.value) return false;
    if (!query) return true;
    return [item.name, item.description, item.content, item.memory_type]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
});

function responsePage(response) {
  const page = response?.data ?? response ?? {};
  const pageItems = Array.isArray(page) ? page : (page.items || []);
  return { items: pageItems, total: Number(page.total ?? pageItems.length) };
}

function scopeOf(item) {
  return item?.scope || item?.target_scope || '-';
}

function isCandidate(item) {
  return Boolean(item && (item.owner_user_id || item.ownerUserId || item.operation));
}

function itemKind(item) {
  return isCandidate(item) ? 'candidate' : 'entry';
}

function isOwnedByCurrentUser(item) {
  const ownerId = item?.owner_user_id || item?.ownerUserId;
  return Boolean(ownerId && ownerId === authStore.user?.id);
}

function typeLabel(type) {
  return typeLabels[type] || type || '-';
}

function statusLabel(status) {
  return statusLabels[status] || status || '-';
}

function operationLabel(operation) {
  return operation === 'archive' ? '归档申请' : '发布申请';
}

function scopeTone(scope) {
  return sharedScopes.has(scope) ? 'info' : 'neutral';
}

function statusTone(status) {
  if (status === 'active' || status === 'approved') return 'success';
  if (status === 'candidate') return 'warning';
  if (status === 'rejected') return 'error';
  return 'neutral';
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

async function getEntryItems(status, scope = '') {
  return responsePage(await listMemoryEntries({ status, scope, limit: 200, offset: 0 }));
}

async function getCandidateItems(status, admin = false) {
  const request = admin ? listAdminMemoryCandidates : listMyMemoryCandidates;
  return responsePage(await request({ status, limit: 200, offset: 0 }));
}

async function loadCurrentView() {
  loading.value = true;
  error.value = '';
  try {
    if (activeView.value === 'mine' || activeView.value === 'shared') {
      const scopes = activeView.value === 'mine' ? personalScopes : sharedScopes;
      const page = await getEntryItems('active', [...scopes].join(','));
      items.value = page.items.filter((item) => scopes.has(scopeOf(item)));
      total.value = page.total;
    } else if (activeView.value === 'pending') {
      const page = await getCandidateItems('candidate', canReview.value);
      items.value = page.items;
      total.value = page.total;
    } else {
      const [archived, approved, rejected, withdrawn] = await Promise.all([
        getEntryItems('archived'),
        getCandidateItems('approved'),
        getCandidateItems('rejected'),
        getCandidateItems('withdrawn'),
      ]);
      items.value = [...archived.items, ...approved.items, ...rejected.items, ...withdrawn.items]
        .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
      total.value = items.value.length;
    }
  } catch (loadError) {
    items.value = [];
    total.value = 0;
    error.value = loadError?.message || '加载 Memory 失败';
  } finally {
    loading.value = false;
  }
}

function openEdit(item) {
  activeItem.value = item;
  editForm.name = item.name || '';
  editForm.description = item.description || '';
  editForm.content = item.content || '';
  editOpen.value = true;
}

function openDetails(item) {
  activeItem.value = item;
  detailsOpen.value = true;
}

async function archiveEntry(item) {
  const isShared = sharedScopes.has(scopeOf(item));
  const accepted = await confirm({
    message: isShared ? `确认发起“${item.name}”的归档申请？` : `确认归档“${item.name}”？`,
    confirmText: isShared ? '发起申请' : '归档',
    danger: true,
  });
  if (!accepted) return;
  busyId.value = item.id;
  try {
    const response = await archiveMemoryEntry(item.id, item.version);
    const result = response?.data ?? response;
    const pendingReview = result?.status === 'candidate' || result?.outcome === 'candidate';
    toast.success(pendingReview || isShared ? '归档申请已提交' : 'Memory 已归档');
    await loadCurrentView();
  } catch (archiveError) {
    toast.error(archiveError?.message || '归档失败');
  } finally {
    busyId.value = '';
  }
}

async function saveCandidate() {
  if (!activeItem.value || !editForm.name.trim() || !editForm.content.trim()) return;
  saving.value = true;
  try {
    await updateMemoryCandidate(activeItem.value.id, {
      expected_version: activeItem.value.version,
      name: editForm.name.trim(),
      description: editForm.description.trim(),
      content: editForm.content.trim(),
    });
    editOpen.value = false;
    toast.success('候选 Memory 已更新');
    await loadCurrentView();
  } catch (saveError) {
    toast.error(saveError?.message || '更新失败');
  } finally {
    saving.value = false;
  }
}

async function withdraw(item) {
  const accepted = await confirm({ message: `确认撤回“${item.name}”？`, confirmText: '撤回', danger: true });
  if (!accepted) return;
  busyId.value = item.id;
  try {
    await withdrawMemoryCandidate(item.id, item.version);
    toast.success('候选 Memory 已撤回');
    await loadCurrentView();
  } catch (withdrawError) {
    toast.error(withdrawError?.message || '撤回失败');
  } finally {
    busyId.value = '';
  }
}

function openReview(item) {
  activeItem.value = item;
  reviewComment.value = '';
  reviewOpen.value = true;
}

async function reviewCandidate(action) {
  if (!activeItem.value || !canReview.value) return;
  reviewing.value = true;
  const payload = {
    expected_version: activeItem.value.version,
    ...(reviewComment.value.trim() ? { comment: reviewComment.value.trim() } : {}),
  };
  try {
    if (action === 'approve') await approveMemoryCandidate(activeItem.value.id, payload);
    else await rejectMemoryCandidate(activeItem.value.id, payload);
    reviewOpen.value = false;
    toast.success(action === 'approve' ? 'Memory 已批准' : 'Memory 已拒绝');
    await loadCurrentView();
  } catch (reviewError) {
    toast.error(reviewError?.message || '审核失败');
  } finally {
    reviewing.value = false;
  }
}

watch(activeView, () => {
  scopeFilter.value = 'all';
  searchQuery.value = '';
  loadCurrentView();
});
watch(() => authStore.tenantId, loadCurrentView);
onMounted(loadCurrentView);
</script>

<style scoped>
.memory-manager {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.section-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--spacing-md);
}

.toolbar-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

.memory-search-input {
  min-width: 220px;
}

.scope-select {
  width: 140px;
}

.data-table-wrapper {
  border-radius: var(--radius-xl);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  overflow: hidden;
}

.memory-table :deep(thead th) {
  height: 38px;
  padding: 0 var(--spacing-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0;
}

.memory-table :deep(tbody td) {
  padding: var(--spacing-sm) var(--spacing-md);
  vertical-align: middle;
}

.memory-name-cell {
  min-width: 260px;
  max-width: 460px;
}

.memory-description {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.memory-time-cell,
.status-badge {
  white-space: nowrap;
}

.cell-secondary {
  color: var(--color-text-secondary);
}

.cell-actions {
  text-align: right;
}

.row-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: nowrap;
  gap: var(--spacing-xs);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  padding: var(--spacing-xl);
  gap: var(--spacing-md);
  color: var(--color-text-muted);
  text-align: center;
}

.table-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md);
  border-top: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

@media (max-width: 720px) {
  .section-toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: var(--spacing-sm);
  }

  .toolbar-right {
    width: 100%;
    min-width: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--spacing-xs);
  }

  .memory-search-input {
    flex: 1 1 220px;
  }

  .memory-table :deep(thead th),
  .memory-table :deep(tbody td) {
    padding: 8px 10px;
  }
}

@media (max-width: 480px) {
  .toolbar-right {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 44px;
    justify-content: stretch;
  }

  .memory-search-input,
  .scope-select {
    width: 100%;
    min-width: 0;
  }

  .memory-search-input {
    grid-column: 1 / -1;
  }

  .memory-table :deep(thead th),
  .memory-table :deep(tbody td) {
    padding: 6px 8px;
    font-size: 12px;
  }
}
</style>
