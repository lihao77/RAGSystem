<template>
                <!-- ══ Tab 3: 向量化器 ════════════════════════════ -->
                <div v-if="activeTab === 'vectorizers'" class="tab-panel">
                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <p class="section-desc">配置多套向量化器，激活后用于新建索引；支持向量化器间的数据迁移。</p>
                        </div>
                        <div class="toolbar-right">
                            <Button variant="secondary" size="icon" aria-label="刷新向量化器" :disabled="vectorizersLoading"
                                @click="refreshVectorizers">
                                <IconRefresh :size="14" :class="{ 'spin': vectorizersLoading }" />
                            </Button>
                            <Button class="toolbar-primary-action" variant="default" size="sm" @click="openAddVectorizerDialog">
                                <IconPlus :size="14" />
                                <span>新增向量化器</span>
                            </Button>
                        </div>
                    </div>

                    <div v-if="vectorizersLoading" class="g-table-loading">
                        <div class="g-skeleton-rows" aria-busy="true"><div v-for="n in 5" :key="n" class="g-skeleton-row"><div class="g-skeleton-bar g-skeleton-bar--title"></div><div class="g-skeleton-bar g-skeleton-bar--sub"></div></div></div>
                    </div>
                    <EmptyState v-else-if="vectorizers.length === 0" title="暂无向量化器，添加后即可在「知识库管理」中建立索引。">
                        <template #icon>
                            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                                <ellipse cx="12" cy="5" rx="9" ry="3" />
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                            </svg>
                        </template>
                        <Button class="primary-action-button" variant="default" size="sm" @click="openAddVectorizerDialog">新增向量化器</Button>
                    </EmptyState>
                    <div v-else class="data-table-wrapper glass-card">
                        <Table class="kb-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>键 (Key)</TableHead>
                                    <TableHead>Provider</TableHead>
                                    <TableHead>模型</TableHead>
                                    <TableHead class="text-center">维度</TableHead>
                                    <TableHead class="text-center">文档数</TableHead>
                                    <TableHead class="text-center">激活</TableHead>
                                    <TableHead class="text-right">操作</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow v-for="v in vectorizers" :key="v.vectorizer_key"
                                    :class="{ 'row-active': v.is_active }">
                                    <TableCell class="font-mono">{{ v.vectorizer_key }}</TableCell>
                                    <TableCell>{{ v.provider_key }}</TableCell>
                                    <TableCell>{{ v.model_name }}</TableCell>
                                    <TableCell class="text-center cell-secondary">{{ v.vector_dimension ?? '-' }}</TableCell>
                                    <TableCell class="text-center cell-secondary">{{ v.vector_count ?? '-' }}</TableCell>
                                    <TableCell class="text-center">
                                        <Badge v-if="v.is_active" class="status-badge" variant="success">当前</Badge>
                                        <Button v-else variant="link"
                                            :disabled="activatingVectorizer === v.vectorizer_key"
                                            @click="handleActivateVectorizer(v.vectorizer_key)">
                                            {{ activatingVectorizer === v.vectorizer_key ? '激活中…' : '激活' }}
                                        </Button>
                                    </TableCell>
                                    <TableCell class="cell-actions">
                                        <div class="row-actions">
                                            <Button variant="action-neutral" size="action"
                                                :disabled="vectorizers.length < 2" @click="openMigrateDialog(v)"
                                                title="迁移数据">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M5 12h14" />
                                                    <path d="M12 5l7 7-7 7" />
                                                </svg>
                                            </Button>
                                            <Button variant="action-danger" size="action"
                                                :disabled="deletingVectorizer === v.vectorizer_key"
                                                @click="handleDeleteVectorizer(v.vectorizer_key)" title="删除">
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
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

const props = defineProps({ context: { type: Object, required: true } });
const { activeTab, showMarkdownPreview, previewFile, previewAnchor, globalLoading, tabs, kpiItems, activeVectorizerDisplay, isDragOver, fileInputRef, handleFileDrop, triggerFileInput, handleFileSelect, mergedFilesLoading, refreshFilesAndStatus, filterCollection, collectionSelectOptions, showIndexDialog, fileStatusVectorizers, uploadedFiles, mergedFileList, formatFileSize, formatTime, openMarkdownPreview, openSearchTest, indexingFileKey, handleIndexFileWithVectorizer, downloadFile, handleDeleteMergedFile, searchCollection, searchResults, searchQuery, handleSearch, searchLoading, searchTopK, searchMode, searchModeOptions, searchRerank, searchRerankerOptions, searchRerankSelection, resultSimilarity, scoreClass, resultSimilarityLabel, searchPerformed, vectorizersLoading, vectorizers, openAddVectorizerDialog, handleActivateVectorizer, activatingVectorizer, openMigrateDialog, deletingVectorizer, handleDeleteVectorizer, rerankersLoading, rerankers, openAddRerankerDialog, activeRerankerDisplay, activatingReranker, deletingReranker, handleActivateReranker, handleDeleteReranker, indexModes, indexMode, indexUploadFile, indexFileInputRef, triggerIndexFileInput, handleIndexFileSelect, handleIndexFileDrop, indexForm, uploadedFileSelectOptions, loadUploadedFilesIfEmpty, autoSetCollectionName, documentTypeOptions, indexing, handleIndexDocument, showAddVectorizerDialog, addVectorizerForm, availableProviderSelectOptions, onAddFormProviderChange, addFormRecommendedModel, addFormModelList, addingVectorizer, showMigrateDialog, migrateFromKey, migrateToKey, migrateTargetOptions, migrating, handleMigrate, showAddRerankerDialog, addRerankerForm, rerankerModeSelectOptions, addRerankerFormValid, addingReranker, handleAddReranker, handleMarkdownNotify, handlePreviewCitation, showToast, refreshVectorizers } = props.context;
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

.cell-actions {
    text-align: right;
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
    .kb-table :deep(thead th), .kb-table :deep(tbody td) {
        padding: 6px 8px;
        font-size: 12px;
    }
}
</style>
