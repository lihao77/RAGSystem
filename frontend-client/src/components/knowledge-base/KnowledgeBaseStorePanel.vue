<template>
                <div v-if="activeTab === 'store'" class="tab-panel">

                    <!-- 当前激活向量化器提示栏 -->
                    <div class="active-bar glass-card">
                        <span class="active-bar__label">当前激活向量化器：</span>
                        <template v-if="activeVectorizerDisplay">
                            <span class="active-bar__tag active-bar__tag--on">{{ activeVectorizerDisplay }}</span>
                        </template>
                        <template v-else>
                            <span class="active-bar__tag active-bar__tag--off">未设置</span>
                            <Button variant="link" @click="activeTab = 'vectorizers'">前往「向量化器」添加并激活 →</Button>
                        </template>
                    </div>

                    <!-- 拖拽上传区 -->
                    <div class="upload-zone glass-card" :class="{ 'upload-zone--dragover': isDragOver }"
                        @dragover.prevent="isDragOver = true" @dragleave.prevent="isDragOver = false"
                        @drop.prevent="handleFileDrop" @click="triggerFileInput">
                        <input ref="fileInputRef" type="file" multiple accept=".pdf,.txt,.md,.doc,.docx,.json"
                            style="display:none" @change="handleFileSelect" />
                        <div class="upload-content">
                            <p class="upload-title">点击或拖拽文件到此处上传</p>
                            <p class="upload-hint">支持 PDF、TXT、MD、DOC、DOCX、JSON，可多选</p>
                        </div>
                    </div>

                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <p class="section-desc">每行为一个已上传文件，每列为一个向量化器，可逐项建立或查看索引状态。</p>
                        </div>
                        <div class="toolbar-right">
                            <Button variant="secondary" size="icon" aria-label="刷新文件与索引状态" :disabled="mergedFilesLoading" @click="refreshFilesAndStatus">
                                <IconRefresh :size="14" :class="{ 'spin': mergedFilesLoading }" />
                            </Button>
                            <div class="filter-select-wrap">
                                <CustomSelect v-model="filterCollection" :options="collectionSelectOptions"
                                    placeholder="全部集合" />
                            </div>
                            <Button class="toolbar-primary-action" variant="default" size="sm" @click="showIndexDialog = true">
                                <IconPlus :size="14" />
                                <span>索引新文档</span>
                            </Button>
                        </div>
                    </div>

                    <!-- 无向量化器警告 -->
                    <div v-if="!mergedFilesLoading && fileStatusVectorizers.length === 0 && uploadedFiles.length > 0"
                        class="warn-banner">
                        <IconWarning :size="16" />
                        <span>尚未配置向量化器，请先在「向量化器」Tab 中添加并激活。</span>
                        <Button variant="link" @click="activeTab = 'vectorizers'">前往配置 →</Button>
                    </div>

                    <!-- 矩阵表格 -->
                    <div class="data-table-wrapper glass-card">
                        <div v-if="mergedFilesLoading" class="g-table-loading">
                            <div class="g-skeleton-rows" aria-busy="true"><div v-for="n in 5" :key="n" class="g-skeleton-row"><div class="g-skeleton-bar g-skeleton-bar--title"></div><div class="g-skeleton-bar g-skeleton-bar--sub"></div></div></div>
                        </div>
                        <EmptyState v-else-if="mergedFileList.length === 0" :icon="IconFile" :icon-size="48"
                            :title="uploadedFiles.length === 0 ? '暂无文件，请先上传文档' : '当前集合下无已索引文件，尝试清空筛选'">
                            <Button v-if="uploadedFiles.length === 0" class="primary-action-button" variant="default" size="sm"
                                @click="triggerFileInput">上传文件</Button>
                        </EmptyState>
                        <Table v-else class="kb-table matrix-table">
                            <TableHeader>
                                <TableRow>
                                    <TableHead class="col-filename">文件名称</TableHead>
                                    <TableHead>大小</TableHead>
                                    <TableHead>上传时间</TableHead>
                                    <TableHead class="text-center">MD 状态</TableHead>
                                    <TableHead v-for="v in fileStatusVectorizers" :key="v.vectorizer_key"
                                        class="col-vectorizer text-center">
                                        <div class="vectorizer-col-header">
                                            <span class="vc-model" :title="v.model_name">{{ v.model_name }}</span>
                                            <span class="vc-tags">
                                                <span class="vc-tag vc-tag--provider">{{ v.provider_key }}</span>
                                                <span class="vc-tag vc-tag--dim">{{ v.dimension }}d</span>
                                            </span>
                                        </div>
                                    </TableHead>
                                    <TableHead class="col-actions text-right">操作</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                <TableRow v-for="row in mergedFileList" :key="row.file_id">
                                    <TableCell>
                                        <div class="cell-filename">
                                            <IconFile :size="14" class="cell-filename__icon" />
                                            <span class="cell-filename__name">{{ row.file_name }}</span>
                                        </div>
                                    </TableCell>
                                    <TableCell class="cell-secondary">{{ formatFileSize(row.size) }}</TableCell>
                                    <TableCell class="cell-secondary">{{ formatTime(row.uploaded_at) }}</TableCell>
                                    <TableCell class="text-center">
                                        <Button variant="action-neutral" size="action" title="预览 Markdown"
                                            :disabled="!row.md_blob_hash" @click="openMarkdownPreview(row)">
                                            {{ row.md_blob_hash ? '预览' : '无' }}
                                        </Button>
                                    </TableCell>
                                    <TableCell v-for="v in fileStatusVectorizers" :key="v.vectorizer_key"
                                        class="text-center">
                                        <Button v-if="row.vectorizer_status?.[v.vectorizer_key]?.indexed"
                                            variant="action-neutral" size="action"
                                            :title="`已索引到 ${row.vectorizer_status[v.vectorizer_key].collections.length} 个集合，点击测试检索`"
                                            @click="openSearchTest(row.vectorizer_status[v.vectorizer_key].collections[0])">
                                            <UiBadge class="status-badge" size="sm" tone="success">已索引<span v-if="row.vectorizer_status[v.vectorizer_key].collections.length > 1"> · {{ row.vectorizer_status[v.vectorizer_key].collections.length }}</span></UiBadge>
                                        </Button>
                                        <Button v-else variant="action-neutral" size="action"
                                            :disabled="indexingFileKey === row.file_id + ':' + v.vectorizer_key"
                                            @click="handleIndexFileWithVectorizer(row, v.vectorizer_key)">
                                            {{ indexingFileKey === row.file_id + ':' + v.vectorizer_key ? '索引中…' : '索引' }}
                                        </Button>
                                    </TableCell>
                                    <TableCell class="cell-actions">
                                        <div class="row-actions">
                                            <Button variant="action-neutral" size="action" title="预览 Markdown"
                                                :disabled="!row.md_blob_hash" @click="openMarkdownPreview(row)">预览</Button>
                                            <Button variant="action-neutral" size="action" title="下载" @click="downloadFile(row)">
                                                <IconDownload :size="13" />
                                            </Button>
                                            <Button variant="action-neutral" size="action"
                                                :disabled="!row.has_index" @click="openSearchTest(row.search_collection)" title="测试检索">
                                                <IconSearch :size="13" />
                                            </Button>
                                            <Button variant="action-danger" size="action"
                                                :disabled="deletingFileId === row.file_id || deletingUploadedFile === row.file_id"
                                                @click="handleDeleteMergedFile(row)" title="删除">
                                                <IconTrash :size="13" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    </div>

                    <!-- 内嵌检索测试区 -->
                    <div v-if="searchCollection" class="search-inline-card glass-card">
                        <div class="search-inline-header">
                            <span class="search-inline-title">检索测试：{{ searchCollection }}</span>
                            <Button variant="action-neutral" size="action"
                                @click="searchCollection = ''; searchResults = []">关闭</Button>
                        </div>
                        <div class="search-box">
                            <input v-model="searchQuery" class="search-input" placeholder="输入查询文本..."
                                @keyup.enter="handleSearch" />
                            <Button class="search-submit-button" variant="default" size="sm" :disabled="searchLoading" @click="handleSearch">
                                <IconSearch :size="14" />
                                <span>{{ searchLoading ? '搜索中...' : '搜索' }}</span>
                            </Button>
                            <div class="search-option">
                                <label>Top K</label>
                                <input v-model.number="searchTopK" type="number" min="1" max="20"
                                    class="option-input" />
                            </div>
                            <div class="search-option">
                                <label>模式</label>
                                <CustomSelect v-model="searchMode" :options="searchModeOptions" />
                            </div>
                            <div class="search-option search-option--toggle">
                                <label class="search-toggle" :class="{ 'search-toggle--disabled': searchMode !== 'hybrid' }">
                                    <input v-model="searchRerank" type="checkbox" :disabled="searchMode !== 'hybrid'" />
                                    <span>重排序</span>
                                </label>
                            </div>
                            <div v-if="searchRerank && searchMode === 'hybrid'" class="search-option">
                                <label>重排序器：</label>
                                <CustomSelect v-model="searchRerankSelection" :options="searchRerankerOptions"
                                    placeholder="使用激活的重排序器" />
                            </div>
                        </div>
                        <div v-if="searchResults.length > 0" class="search-results">
                            <div v-for="(r, i) in searchResults" :key="i" class="result-item">
                                <div class="result-header">
                                    <span class="result-rank">#{{ i + 1 }}</span>
                                    <span :class="['result-score', scoreClass(resultSimilarity(r))]">
                                        {{ resultSimilarityLabel(r) }}
                                    </span>
                                    <span class="result-source">{{ r.metadata?.source || r.metadata?.document_id ||
                                        '未知来源' }}</span>
                                </div>
                                <div class="result-meta-row">
                                    <span v-if="r.hybrid_score != null" class="result-meta-chip">Hybrid {{ formatScore(r.hybrid_score) }}</span>
                                    <span v-if="r.rerank_score != null" class="result-meta-chip">Rerank {{ formatScore(r.rerank_score) }}</span>
                                    <span v-if="r.rerank_rank != null" class="result-meta-chip">Rerank #{{ r.rerank_rank }}</span>
                                    <span v-if="r.vector_rank != null" class="result-meta-chip">Vector #{{ r.vector_rank }}</span>
                                    <span v-if="r.keyword_rank != null" class="result-meta-chip">Keyword #{{ r.keyword_rank }}</span>
                                    <span v-for="source in (r.retrieval_sources || [])" :key="source" class="result-meta-chip">{{ source }}</span>
                                </div>
                                <div v-if="r.metadata?.section_path" class="result-section">{{ r.metadata.section_path }}</div>
                                <div class="result-content">{{ r.content || r.text }}</div>
                                <div v-if="r.metadata?.chunk_index != null" class="result-footer">
                                    分块 {{ r.metadata.chunk_index }} / {{ r.metadata.chunk_total }}
                                </div>
                            </div>
                        </div>
                        <EmptyState v-else-if="searchPerformed" compact title="未找到相关结果，尝试更换关键词或切换集合">
                            <template #icon>
                                <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
                                    stroke-linejoin="round">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                    <line x1="8" y1="11" x2="14" y2="11" />
                                </svg>
                            </template>
                        </EmptyState>
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
const { activeTab, showMarkdownPreview, previewFile, previewAnchor, globalLoading, tabs, kpiItems, activeVectorizerDisplay, isDragOver, fileInputRef, handleFileDrop, triggerFileInput, handleFileSelect, mergedFilesLoading, refreshFilesAndStatus, filterCollection, collectionSelectOptions, showIndexDialog, fileStatusVectorizers, uploadedFiles, mergedFileList, formatFileSize, formatTime, openMarkdownPreview, openSearchTest, indexingFileKey, handleIndexFileWithVectorizer, downloadFile, handleDeleteMergedFile, searchCollection, searchResults, searchQuery, handleSearch, searchLoading, searchTopK, searchMode, searchModeOptions, searchRerank, searchRerankerOptions, searchRerankSelection, resultSimilarity, scoreClass, resultSimilarityLabel, searchPerformed, vectorizersLoading, vectorizers, openAddVectorizerDialog, handleActivateVectorizer, activatingVectorizer, openMigrateDialog, deletingVectorizer, handleDeleteVectorizer, rerankersLoading, rerankers, openAddRerankerDialog, activeRerankerDisplay, activatingReranker, deletingReranker, handleActivateReranker, handleDeleteReranker, indexModes, indexMode, indexUploadFile, indexFileInputRef, triggerIndexFileInput, handleIndexFileSelect, handleIndexFileDrop, indexForm, uploadedFileSelectOptions, loadUploadedFilesIfEmpty, autoSetCollectionName, documentTypeOptions, indexing, handleIndexDocument, showAddVectorizerDialog, addVectorizerForm, availableProviderSelectOptions, onAddFormProviderChange, addFormRecommendedModel, addFormModelList, addingVectorizer, showMigrateDialog, migrateFromKey, migrateToKey, migrateTargetOptions, migrating, handleMigrate, showAddRerankerDialog, addRerankerForm, rerankerModeSelectOptions, addRerankerFormValid, addingReranker, handleAddReranker, handleMarkdownNotify, handlePreviewCitation, showToast, deletingFileId, deletingUploadedFile, formatScore } = props.context;
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
.filter-select-wrap {
    width: 160px;
}
.warn-banner {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: 12px 16px;
    border-radius: var(--radius-lg);
    background: rgba(var(--color-warning-rgb), 0.1);
    border: 1px solid rgba(var(--color-warning-rgb), 0.25);
    color: var(--color-warning);
    font-size: var(--font-size-sm);
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
.col-filename {
    min-width: 220px;
}

.col-vectorizer {
    min-width: 160px;
}

.col-actions {
    width: 1%;
    white-space: nowrap;
}

.text-center {
    text-align: center !important;
}

.cell-filename {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    color: var(--color-text-primary);
    font-weight: 500;
}

.cell-filename__icon {
    color: var(--color-text-muted);
    flex-shrink: 0;
}

.cell-filename__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
}

.cell-secondary {
    color: var(--color-text-secondary);
}

.cell-actions {
    text-align: right;
}
.vectorizer-col-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
}

.vc-model {
    font-size: var(--font-size-xs);
    font-weight: 600;
    color: var(--color-text-primary);
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vc-tags {
    display: flex;
    align-items: center;
    gap: 3px;
}

.vc-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    font-size: 10px;
    font-weight: 500;
    line-height: 1.4;
}

.vc-tag--provider {
    background: rgba(var(--color-brand-accent-rgb), 0.14);
    color: var(--color-brand-accent-light);
}

.vc-tag--dim {
    background: rgba(var(--color-warning-rgb), 0.14);
    color: var(--color-warning);
}
.status-badge {
    white-space: nowrap;
}
.search-inline-card {
    padding: var(--spacing-md);
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-border);
    background: var(--color-bg-elevated);
}

.search-inline-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-md);
}

.search-inline-title {
    font-size: var(--font-size-md);
    font-weight: 600;
    color: var(--color-text-primary);
}
.upload-zone {
    border-radius: var(--radius-xl);
    border: 2px dashed var(--color-border);
    background: var(--color-bg-secondary);
    padding: var(--spacing-xl);
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
}

.upload-zone:hover {
    border-color: var(--color-border-hover);
    background: var(--color-bg-tertiary);
}

.upload-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-md);
}

.upload-title {
    font-size: var(--font-size-md);
    font-weight: 500;
    color: var(--color-text-primary);
    margin: 0;
}

.upload-hint {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    margin: 0;
}

.search-box {
    display: flex;
    gap: var(--spacing-sm);
    margin-bottom: var(--spacing-md);
}

.search-input {
    flex: 1;
    height: 44px;
    padding: 0 var(--spacing-md);
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text-primary);
    font: inherit;
    font-size: var(--font-size-md);
    outline: none;
    transition: all 0.2s;
}

.search-input:focus {
    border-color: var(--color-border-focus);
    box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}

.search-input::placeholder {
    color: var(--color-text-muted);
}

.search-option {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
}

.search-option--toggle {
    min-height: 34px;
}

.search-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    user-select: none;
}

.search-toggle input {
    width: 14px;
    height: 14px;
    margin: 0;
    accent-color: var(--color-brand-accent);
}

.option-input {
    width: 72px;
    height: 34px;
    padding: 0 var(--spacing-sm);
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text-primary);
    font: inherit;
}

.search-results {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
}

.result-item {
    padding: var(--spacing-md);
}

.result-header {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    margin-bottom: var(--spacing-sm);
    flex-wrap: wrap;
}

.result-rank {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(var(--color-brand-accent-rgb), 0.15);
    color: var(--color-brand-accent-light);
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
}

.result-source {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    margin-left: auto;
}

.result-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: var(--spacing-xs);
}

.result-meta-chip {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    padding: 1px 7px;
    border-radius: var(--radius-full);
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 500;
}

.result-section {
    margin-bottom: var(--spacing-xs);
    color: var(--color-brand-accent-light);
    font-size: var(--font-size-xs);
    line-height: 1.5;
}

.result-content {
    font-size: var(--font-size-sm);
    color: var(--color-text-primary);
    line-height: 1.7;
    max-height: 180px;
    overflow-y: auto;
}

.result-footer {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    margin-top: var(--spacing-xs);
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
    .filter-select-wrap {
        flex: 1;
        min-width: 120px;
        width: auto;
    }
    .kb-table :deep(thead th), .kb-table :deep(tbody td) {
        padding: 8px 10px;
    }
    .search-inline-card .search-box {
        flex-wrap: wrap;
    }

    .search-inline-card .search-input {
        flex: 1 1 100%;
    }
    .search-box {
        flex-wrap: wrap;
        justify-content: flex-end;
    }

    .search-input {
        flex: 1 1 100%;
    }
    .upload-zone {
        padding: var(--spacing-lg) var(--spacing-md);
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

    .search-box .search-submit-button {
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

    .col-filename {
        min-width: 120px;
    }

    .col-vectorizer {
        min-width: 100px;
    }
    .result-item {
        padding: var(--spacing-sm);
    }
    .active-bar {
        flex-wrap: wrap;
        gap: var(--spacing-xs);
    }
}
</style>
