<template>
                <!-- ══ Tab 4: 重排序器 ════════════════════════════ -->
                <div v-if="activeTab === 'rerankers'" class="tab-panel">
                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <p class="section-desc">配置重排序器，激活后搜索时自动使用；支持本地 BM25 和远程模型两种模式。</p>
                        </div>
                        <div class="toolbar-right">
                            <Button variant="secondary" size="icon" aria-label="刷新重排序器" :disabled="rerankersLoading"
                                @click="refreshRerankers">
                                <IconRefresh :size="14" :class="{ 'spin': rerankersLoading }" />
                            </Button>
                            <Button class="toolbar-primary-action" variant="default" size="sm" @click="openAddRerankerDialog">
                                <IconPlus :size="14" />
                                <span>新增重排序器</span>
                            </Button>
                        </div>
                    </div>

                    <!-- 当前激活重排序器提示栏 -->
                    <div class="active-bar glass-card" style="margin-bottom: var(--spacing-md)">
                        <span class="active-bar__label">当前激活重排序器：</span>
                        <template v-if="activeRerankerDisplay">
                            <span class="active-bar__tag active-bar__tag--on">{{ activeRerankerDisplay }}</span>
                        </template>
                        <template v-else>
                            <span class="active-bar__tag active-bar__tag--off">未设置</span>
                        </template>
                    </div>

                    <div v-if="rerankersLoading" class="g-table-loading">
                        <div class="g-skeleton-rows" aria-busy="true"><div v-for="n in 5" :key="n" class="g-skeleton-row"><div class="g-skeleton-bar g-skeleton-bar--title"></div><div class="g-skeleton-bar g-skeleton-bar--sub"></div></div></div>
                    </div>
                    <EmptyState v-else-if="rerankers.length === 0" title="暂无重排序器，添加后即可在搜索时自动使用。">
                        <template #icon>
                            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="4" y1="9" x2="20" y2="9" />
                                <line x1="4" y1="15" x2="20" y2="15" />
                                <line x1="10" y1="3" x2="8" y2="21" />
                                <line x1="16" y1="3" x2="14" y2="21" />
                            </svg>
                        </template>
                        <Button class="primary-action-button" variant="default" size="sm" @click="openAddRerankerDialog">新增重排序器</Button>
                    </EmptyState>
                    <div v-else class="data-table-wrapper glass-card">
                        <Table class="kb-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>键 (Key)</TableHead>
                                    <TableHead>模式</TableHead>
                                    <TableHead>Provider</TableHead>
                                    <TableHead>模型</TableHead>
                                    <TableHead>API Endpoint</TableHead>
                                    <TableHead class="text-center">激活</TableHead>
                                    <TableHead class="text-right">操作</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow v-for="r in rerankers" :key="r.reranker_key"
                                    :class="{ 'row-active': r.is_active }">
                                    <TableCell class="font-mono">{{ r.reranker_key }}</TableCell>
                                    <TableCell>
                                        <UiBadge size="sm" :tone="r.mode === 'model' ? 'info' : r.mode === 'lexical' ? 'warning' : 'neutral'">
                                            {{ r.mode === 'model' ? '模型' : r.mode === 'lexical' ? '本地' : '无' }}
                                        </UiBadge>
                                    </TableCell>
                                    <TableCell>{{ r.provider_key || '-' }}</TableCell>
                                    <TableCell>{{ r.model_name || '-' }}</TableCell>
                                    <TableCell class="font-mono cell-endpoint" :title="r.api_endpoint || ''">{{ r.api_endpoint || '-' }}</TableCell>
                                    <TableCell class="text-center">
                                        <UiBadge v-if="r.is_active" class="status-badge" size="sm" tone="success">当前</UiBadge>
                                        <Button v-else variant="link"
                                            :disabled="activatingReranker === r.reranker_key"
                                            @click="handleActivateReranker(r.reranker_key)">
                                            {{ activatingReranker === r.reranker_key ? '激活中…' : '激活' }}
                                        </Button>
                                    </TableCell>
                                    <TableCell class="cell-actions">
                                        <div class="row-actions">
                                            <Button variant="action-danger" size="action"
                                                :disabled="deletingReranker === r.reranker_key"
                                                @click="handleDeleteReranker(r.reranker_key)" title="删除">
                                                <IconTrash :size="13" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    </div>
                </div>

</template>

<script setup>
/* eslint-disable @typescript-eslint/no-unused-vars */

import IconRefresh from '../icons/IconRefresh.vue';
import IconPlus from '../icons/IconPlus.vue';
import IconSearch from '../icons/IconSearch.vue';
import IconTrash from '../icons/IconTrash.vue';
import IconWarning from '../icons/IconWarning.vue';
import IconFile from '../icons/IconFile.vue';
import IconDownload from '../icons/IconDownload.vue';
import KnowledgeMdViewer from '../knowledge/KnowledgeMdViewer.vue';
import EmptyState from '../EmptyState.vue';
import KpiCards from '../admin/KpiCards.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import CustomSelect from '../ui/CustomSelect.vue';
import { UiBadge } from '../ui';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

const props = defineProps({ context: { type: Object, required: true } });
const { activeTab, showMarkdownPreview, previewFile, previewAnchor, globalLoading, tabs, kpiItems, activeVectorizerDisplay, isDragOver, fileInputRef, handleFileDrop, triggerFileInput, handleFileSelect, mergedFilesLoading, refreshFilesAndStatus, filterCollection, collectionSelectOptions, showIndexDialog, fileStatusVectorizers, uploadedFiles, mergedFileList, formatFileSize, formatTime, openMarkdownPreview, openSearchTest, indexingFileKey, handleIndexFileWithVectorizer, downloadFile, handleDeleteMergedFile, searchCollection, searchResults, searchQuery, handleSearch, searchLoading, searchTopK, searchMode, searchModeOptions, searchRerank, searchRerankerOptions, searchRerankSelection, resultSimilarity, scoreClass, resultSimilarityLabel, searchPerformed, vectorizersLoading, vectorizers, openAddVectorizerDialog, handleActivateVectorizer, activatingVectorizer, openMigrateDialog, deletingVectorizer, handleDeleteVectorizer, rerankersLoading, rerankers, openAddRerankerDialog, activeRerankerDisplay, activatingReranker, deletingReranker, handleActivateReranker, handleDeleteReranker, indexModes, indexMode, indexUploadFile, indexFileInputRef, triggerIndexFileInput, handleIndexFileSelect, handleIndexFileDrop, indexForm, uploadedFileSelectOptions, loadUploadedFilesIfEmpty, autoSetCollectionName, documentTypeOptions, indexing, handleIndexDocument, showAddVectorizerDialog, addVectorizerForm, availableProviderSelectOptions, onAddFormProviderChange, addFormRecommendedModel, addFormModelList, addingVectorizer, showMigrateDialog, migrateFromKey, migrateToKey, migrateTargetOptions, migrating, handleMigrate, showAddRerankerDialog, addRerankerForm, rerankerModeSelectOptions, addRerankerFormValid, addingReranker, handleAddReranker, handleMarkdownNotify, handlePreviewCitation, showToast, refreshRerankers } = props.context;
</script>

<style scoped>


.tab-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
}
.active-bar {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: 10px 16px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
    font-size: var(--font-size-sm);
}

.active-bar__label {
    color: var(--color-text-secondary);
}

.active-bar__tag {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: var(--radius-full);
    font-size: var(--font-size-xs);
    font-weight: 600;
}

.active-bar__tag--on {
    background: rgba(var(--color-success-rgb), 0.15);
    color: var(--color-success);
    border: 1px solid rgba(var(--color-success-rgb), 0.25);
}

.active-bar__tag--off {
    background: rgba(var(--color-warning-rgb), 0.15);
    color: var(--color-warning);
    border: 1px solid rgba(var(--color-warning-rgb), 0.25);
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
}
.row-actions {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--spacing-xs);
}
.data-table-wrapper {
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
    overflow: hidden;
}
.kb-table :deep(thead th) {
    height: 38px;
    padding: 0 var(--spacing-md);
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
    font-weight: 600;
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

.cell-actions {
    text-align: right;
}

.cell-endpoint {
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.status-badge {
    white-space: nowrap;
}
.loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--spacing-xl);
    gap: var(--spacing-md);
    color: var(--color-text-muted);
    text-align: center;
    min-height: 160px;
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
        gap: var(--spacing-xs);
        width: 100%;
        min-width: 0;
    }
    .kb-table :deep(thead th), .kb-table :deep(tbody td) {
        padding: 8px 10px;
    }
}
@media (max-width: 480px) {
    .primary-action-button, .toolbar-primary-action, .search-submit-button {
        font-size: 12px;
    }

    .toolbar-right {
        display: grid;
        grid-template-columns: 44px minmax(0, 1fr);
        justify-content: stretch;
    }

    .toolbar-right .filter-select-wrap {
        min-width: 0;
        width: 100%;
    }

    .toolbar-right .toolbar-primary-action {
        grid-column: 1 / -1;
        width: 100%;
    }

    .active-bar {
        min-width: 0;
    }

    .active-bar__tag {
        max-width: 100%;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .kb-table :deep(thead th), .kb-table :deep(tbody td) {
        padding: 6px 8px;
        font-size: 12px;
    }
    .active-bar {
        flex-wrap: wrap;
        gap: var(--spacing-xs);
    }
}
</style>
