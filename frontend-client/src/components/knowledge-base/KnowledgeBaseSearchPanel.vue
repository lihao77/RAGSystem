<!-- eslint-disable no-unused-vars, @typescript-eslint/no-unused-vars -->
<template>
                <!-- ══ Tab 5: 搜索测试 ════════════════════════════ -->
                <div v-if="activeTab === 'search'" class="tab-panel">
                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <p class="section-desc">输入查询文本，测试向量检索效果。</p>
                        </div>
                    </div>

                    <div class="search-form-card glass-card">
                        <div class="search-box">
                            <input v-model="searchQuery" class="search-input" placeholder="输入搜索关键词..."
                                @keyup.enter="handleSearch" />
                            <Button class="search-submit-button" variant="default" size="sm" :disabled="searchLoading" @click="handleSearch">
                                <IconSearch :size="15" />
                                <span>{{ searchLoading ? '搜索中...' : '搜索' }}</span>
                            </Button>
                        </div>
                        <div class="search-options-row">
                            <div class="search-option">
                                <label>Top K：</label>
                                <input v-model.number="searchTopK" type="number" min="1" max="20"
                                    class="option-input" />
                            </div>
                            <div class="search-option">
                                <label>模式：</label>
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
                            <div class="search-option">
                                <label>集合：</label>
                                <input v-model="searchCollection" class="option-input option-input--wide"
                                    placeholder="留空全局搜索" />
                            </div>
                        </div>
                    </div>

                    <div v-if="searchResults.length > 0" class="search-results">
                        <p class="results-count">共 {{ searchResults.length }} 条结果</p>
                        <div v-for="(r, i) in searchResults" :key="i" class="result-item glass-card">
                            <div class="result-header">
                                <span class="result-rank">#{{ i + 1 }}</span>
                                <span :class="['result-score', scoreClass(resultSimilarity(r))]">
                                    {{ resultSimilarityLabel(r) }}
                                </span>
                                <span class="result-source">{{ r.metadata?.source || r.metadata?.document_id || '未知来源'
                                }}</span>
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
                    <div v-else-if="searchPerformed" class="empty-state adm-state adm-state--empty glass-card" style="padding: var(--spacing-xl)">
                        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24"
                            fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
                            stroke-linejoin="round">
                            <circle cx="11" cy="11" r="8" />
                            <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            <line x1="8" y1="11" x2="14" y2="11" />
                        </svg>
                        <p>未找到相关结果，尝试更换关键词或切换集合</p>
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
import KpiCards from '../admin/KpiCards.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import CustomSelect from '../ui/CustomSelect.vue';
import { UiBadge } from '../ui';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

const props = defineProps({ context: { type: Object, required: true } });
const { activeTab, showMarkdownPreview, previewFile, previewAnchor, globalLoading, tabs, kpiItems, activeVectorizerDisplay, isDragOver, fileInputRef, handleFileDrop, triggerFileInput, handleFileSelect, mergedFilesLoading, refreshFilesAndStatus, filterCollection, collectionSelectOptions, showIndexDialog, fileStatusVectorizers, uploadedFiles, mergedFileList, formatFileSize, formatTime, openMarkdownPreview, openSearchTest, indexingFileKey, handleIndexFileWithVectorizer, downloadFile, handleDeleteMergedFile, searchCollection, searchResults, searchQuery, handleSearch, searchLoading, searchTopK, searchMode, searchModeOptions, searchRerank, searchRerankerOptions, searchRerankSelection, resultSimilarity, scoreClass, resultSimilarityLabel, searchPerformed, vectorizersLoading, vectorizers, openAddVectorizerDialog, handleActivateVectorizer, activatingVectorizer, openMigrateDialog, deletingVectorizer, handleDeleteVectorizer, rerankersLoading, rerankers, openAddRerankerDialog, activeRerankerDisplay, activatingReranker, deletingReranker, handleActivateReranker, handleDeleteReranker, indexModes, indexMode, indexUploadFile, indexFileInputRef, triggerIndexFileInput, handleIndexFileSelect, handleIndexFileDrop, indexForm, uploadedFileSelectOptions, loadUploadedFilesIfEmpty, autoSetCollectionName, documentTypeOptions, indexing, handleIndexDocument, showAddVectorizerDialog, addVectorizerForm, availableProviderSelectOptions, onAddFormProviderChange, addFormRecommendedModel, addFormModelList, addingVectorizer, showMigrateDialog, migrateFromKey, migrateToKey, migrateTargetOptions, migrating, handleMigrate, showAddRerankerDialog, addRerankerForm, rerankerModeSelectOptions, addRerankerFormValid, addingReranker, handleAddReranker, handleMarkdownNotify, handlePreviewCitation, showToast } = props.context;
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

.section-desc {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    margin: 0;
}
.search-form-card {
    padding: var(--spacing-lg);
    border-radius: var(--radius-lg);
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

.search-options-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
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

.option-input--wide {
    width: 160px;
}
.results-count {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    margin: 0 0 var(--spacing-sm) 0;
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
.loading-state, .empty-state {
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

.empty-state svg {
    opacity: 0.35;
}
@media (max-width: 720px) {
    .section-toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: var(--spacing-sm);
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

    .search-options-row {
        flex-wrap: wrap;
        gap: var(--spacing-sm);
    }
}
@media (max-width: 480px) {
    .primary-action-button, .toolbar-primary-action, .search-submit-button {
        font-size: 12px;
    }

    .search-box .search-submit-button {
        width: 100%;
    }
    .result-item {
        padding: var(--spacing-sm);
    }
}
</style>
