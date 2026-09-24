<template>
    <!-- ══ Tab: 模型服务（知识库插件自管 embedding/rerank Provider）══════ -->
    <div v-if="activeTab === 'model-providers'" class="tab-panel">
        <div class="section-toolbar">
            <div class="toolbar-left">
                <p class="section-desc">
                    Embedding / Rerank 模型服务由知识库插件自管（凭证存插件自有存储，不占用「模型 Provider 管理」页的对话 Provider 条目）。向量化器与重排序器从这里选择模型服务。
                </p>
            </div>
            <div class="toolbar-right">
                <Button variant="secondary" size="icon" aria-label="刷新模型服务" :disabled="modelProvidersLoading"
                    @click="refreshModelProviders">
                    <IconRefresh :class="{ 'spin': modelProvidersLoading }" />
                </Button>
                <Button class="toolbar-primary-action" variant="default" size="default" @click="openAddModelProviderDialog('embedding')">
                    <IconPlus />
                    <span>新增模型服务</span>
                </Button>
            </div>
        </div>

        <div v-if="modelProvidersLoading" class="g-table-loading">
            <div class="g-skeleton-rows" aria-busy="true"><div v-for="n in 3" :key="n" class="g-skeleton-row"><div class="g-skeleton-bar g-skeleton-bar--title"></div><div class="g-skeleton-bar g-skeleton-bar--sub"></div></div></div>
        </div>
        <EmptyState v-else-if="modelProviders.length === 0" title="暂无模型服务。新增后即可在向量化器 / 重排序器中使用。">
            <Button class="primary-action-button" variant="default" size="sm" @click="openAddModelProviderDialog('embedding')">新增模型服务</Button>
        </EmptyState>
        <div v-else class="data-table-wrapper glass-card">
            <Table class="kb-table">
                <TableHeader>
                    <TableRow>
                        <TableHead>名称</TableHead>
                        <TableHead>类型</TableHead>
                        <TableHead>API Endpoint</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead class="text-center">密钥</TableHead>
                        <TableHead class="text-right">操作</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    <TableRow v-for="p in modelProviders" :key="p.provider_key">
                        <TableCell class="font-mono">{{ p.name }}</TableCell>
                        <TableCell>
                            <Badge class="status-badge" :variant="p.kind === 'embedding' ? 'default' : 'secondary'">
                                {{ p.kind === 'embedding' ? 'Embedding' : 'Rerank' }}
                            </Badge>
                        </TableCell>
                        <TableCell class="cell-secondary cell-ellipsis" :title="p.api_endpoint">{{ p.api_endpoint }}</TableCell>
                        <TableCell class="font-mono">{{ p.model_name }}</TableCell>
                        <TableCell class="text-center">
                            <Badge class="status-badge" :variant="p.api_key_configured ? 'success' : 'destructive'">
                                {{ p.api_key_configured ? '已配置' : '未配置' }}
                            </Badge>
                        </TableCell>
                        <TableCell class="cell-actions">
                            <div class="row-actions">
                                <Button variant="action-neutral" size="action" title="编辑"
                                    @click="openEditModelProviderDialog(p)">
                                    <Pencil />
                                </Button>
                                <Button variant="action-danger" size="action" title="删除"
                                    :disabled="deletingModelProviderKey === p.provider_key"
                                    @click="handleDeleteModelProvider(p.provider_key)">
                                    <IconTrash />
                                </Button>
                            </div>
                        </TableCell>
                    </TableRow>
                </TableBody>
            </Table>
        </div>

        <!-- 新增 / 编辑模型服务对话框 -->
        <Dialog v-model:open="showModelProviderDialog">
            <DialogContent class="max-w-[520px]">
                <DialogHeader>
                    <DialogTitle>{{ modelProviderForm.provider_key ? '编辑模型服务' : '新增模型服务' }}</DialogTitle>
                </DialogHeader>
                <div class="form-grid">
                    <div class="field">
                        <label>类型 <em>*</em></label>
                        <CustomSelect v-model="modelProviderForm.kind" :options="modelProviderKindOptions" />
                    </div>
                    <div class="field">
                        <label>名称 <em>*</em></label>
                        <Input v-model="modelProviderForm.name" placeholder="如 百度千帆 BCE" />
                    </div>
                    <div class="field field--full">
                        <label>API Endpoint <em>*</em></label>
                        <Input v-model="modelProviderForm.api_endpoint" placeholder="https://... （OpenAI 兼容，自动追加 /embeddings 或 /rerank）" />
                    </div>
                    <div class="field field--full">
                        <label>API Key <em v-if="!modelProviderForm.provider_key">*</em></label>
                        <Input v-model="modelProviderForm.api_key" type="password"
                            :placeholder="modelProviderForm.provider_key ? '留空保留原值' : 'sk-...（支持 ${ENV_VAR} 占位符）'" />
                    </div>
                    <div class="field field--full">
                        <label>模型名 <em>*</em></label>
                        <Input v-model="modelProviderForm.model_name" placeholder="如 bce-embedding-v1 / jina-reranker-v2" />
                    </div>
                </div>
                <DialogFooter>
                    <Button size="sm" @click="showModelProviderDialog = false">取消</Button>
                    <Button size="sm" variant="default" :disabled="!modelProviderFormValid || savingModelProvider"
                        @click="handleSaveModelProvider">
                        {{ savingModelProvider ? '保存中...' : '保存' }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </div>
</template>

<script setup>
import IconRefresh from '../icons/IconRefresh.vue';
import IconPlus from '../icons/IconPlus.vue';
import IconTrash from '../icons/IconTrash.vue';
import { Pencil } from 'lucide-vue-next';
import EmptyState from '../EmptyState.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import CustomSelect from '../ui/CustomSelect.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

const props = defineProps({ context: { type: Object, required: true } });
const {
    activeTab,
    modelProviders,
    modelProvidersLoading,
    refreshModelProviders,
    openAddModelProviderDialog,
    openEditModelProviderDialog,
    handleDeleteModelProvider,
    deletingModelProviderKey,
    showModelProviderDialog,
    modelProviderForm,
    modelProviderKindOptions,
    modelProviderFormValid,
    savingModelProvider,
    handleSaveModelProvider,
} = props.context;
</script>

<style scoped>
.tab-panel {
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
.section-desc {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    margin: 0;
    max-width: 640px;
}
.row-actions {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--spacing-xs);
}
.data-table-wrapper {
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    overflow: hidden;
}
.kb-table :deep(thead th) {
    height: 36px;
    padding: 0 var(--spacing-md);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
.kb-table :deep(tbody td) {
    padding: var(--spacing-sm) var(--spacing-md);
    vertical-align: middle;
}
.text-center {
    text-align: center !important;
}
.font-mono {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
}
.cell-secondary {
    color: var(--color-text-secondary);
}
.cell-ellipsis {
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.cell-actions {
    text-align: right;
}
.status-badge {
    white-space: nowrap;
}
.form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--spacing-md) var(--spacing-sm);
}
.field--full {
    grid-column: 1 / -1;
}
.field label {
    display: block;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    margin-bottom: 4px;
}
.field label em {
    color: var(--color-warning);
    font-style: normal;
}
@media (max-width: 720px) {
    .section-toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: var(--spacing-sm);
    }
    .toolbar-right {
        flex-wrap: wrap;
        justify-content: flex-end;
    }
    .form-grid {
        grid-template-columns: 1fr;
    }
}
</style>
