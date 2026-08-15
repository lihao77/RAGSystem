<template>
        <!-- 索引新文档对话框 -->
        <Dialog v-model:open="showIndexDialog">
          <DialogContent class="max-w-[680px]">
            <DialogHeader>
              <DialogTitle>索引新文档</DialogTitle>
            </DialogHeader>
                    <SegmentedControl v-model="indexMode" :options="indexModes" aria-label="索引方式" />

                    <div class="form-grid" style="margin-top: var(--spacing-md)">
                            <template v-if="indexMode === 'upload'">
                                <div class="field field--full">
                                    <label>选择文件 <em>*</em></label>
                                    <div class="mini-upload-zone" :class="{ 'mini-upload-zone--has': indexUploadFile }"
                                        @click="triggerIndexFileInput" @dragover.prevent
                                        @drop.prevent="handleIndexFileDrop">
                                        <input ref="indexFileInputRef" type="file"
                                            accept=".txt,.md,.json,.pdf,.doc,.docx" style="display:none"
                                            @change="handleIndexFileSelect" />
                                        <template v-if="indexUploadFile">
                                            <IconFile :size="20" />
                                            <span>{{ indexUploadFile.name }}</span>
                                            <Button variant="action-danger" size="action" style="margin-left:auto"
                                                @click.stop="indexUploadFile = null">移除</Button>
                                        </template>
                                        <template v-else>
                                            <span>拖拽或点击选择文件</span>
                                        </template>
                                    </div>
                                </div>
                            </template>
                            <template v-if="indexMode === 'select'">
                                <div class="field field--full">
                                    <label>选择文件 <em>*</em></label>
                                    <CustomSelect v-model="indexForm.file_id" :options="uploadedFileSelectOptions"
                                        placeholder="-- 请选择已上传文件 --" @change="loadUploadedFilesIfEmpty" />
                                </div>
                            </template>
                            <template v-if="indexMode === 'text'">
                                <div class="field field--full">
                                    <label>文档ID <em>*</em></label>
                                    <Input v-model="indexForm.document_id" placeholder="如: my_doc_001" />
                                </div>
                                <div class="field field--full">
                                    <label>文档内容 <em>*</em></label>
                                    <Textarea v-model="indexForm.text" rows="6" placeholder="输入要索引的文档内容..."></Textarea>
                                </div>
                                <div class="field field--full">
                                    <label>来源</label>
                                    <Input v-model="indexForm.metadata.source" placeholder="如：技术文档、应急预案" />
                                </div>
                            </template>
                            <div class="field">
                                <label>集合名称</label>
                                <div class="input-with-btn">
                                    <Input v-model="indexForm.collection_name" placeholder="documents" />
                                    <Button variant="link" @click="autoSetCollectionName"
                                        title="根据文档类型自动设置">自动</Button>
                                </div>
                            </div>
                            <div v-if="indexMode !== 'text'" class="field">
                                <label>文档ID</label>
                                <Input v-model="indexForm.document_id"
                                    :placeholder="indexMode === 'upload' ? '留空使用文件名' : '留空使用文件ID'" />
                            </div>
                            <div class="field">
                                <label>文档类型</label>
                                <CustomSelect v-model="indexForm.metadata.document_type" :options="documentTypeOptions"
                                    @change="autoSetCollectionName" />
                            </div>
                            <div class="field">
                                <label>分块大小（字符）</label>
                                <Input v-model.number="indexForm.chunk_size" type="number" min="100" max="2000"
                                    step="100" />
                                <small>建议 300–800</small>
                            </div>
                            <div class="field">
                                <label>分块重叠</label>
                                <Input v-model.number="indexForm.overlap" type="number" min="0" max="500" step="10" />
                                <small>建议为分块大小的 10%</small>
                            </div>
                    </div>
                    <DialogFooter>
                        <Button size="sm" @click="showIndexDialog = false">取消</Button>
                        <Button size="sm" variant="default" :disabled="indexing" @click="handleIndexDocument">
                            {{ indexing ? '索引中...' : '开始索引' }}
                        </Button>
                    </DialogFooter>
          </DialogContent>
        </Dialog>
        <KnowledgeMdViewer v-model:open="showMarkdownPreview" :file-id="previewFile?.id || ''"
            :file-name="previewFile?.original_name || ''" :initial-char-start="previewAnchor.char_start" :initial-heading="previewAnchor.heading" @notify="handleMarkdownNotify" @citation-click="handlePreviewCitation" />

        <!-- 新增向量化器对话框 -->
        <Dialog v-model:open="showAddVectorizerDialog">
          <DialogContent class="max-w-[480px]">
            <DialogHeader>
              <DialogTitle>新增向量化器</DialogTitle>
            </DialogHeader>
                    <div class="form-grid">
                            <div class="field field--full">
                                <label>Provider <em>*</em></label>
                                <CustomSelect v-model="addVectorizerForm.provider_key"
                                    :options="availableProviderSelectOptions" placeholder="-- 选择 Provider --"
                                    @change="onAddFormProviderChange" />
                            </div>
                            <div class="field field--full">
                                <label>模型名称 <em>*</em></label>
                                <Input v-model="addVectorizerForm.model_name" list="add-model-list"
                                    placeholder="选择或输入模型名" />
                                <datalist id="add-model-list">
                                    <option v-if="addFormRecommendedModel" :value="addFormRecommendedModel">
                                        {{ addFormRecommendedModel }} (推荐)
                                    </option>
                                    <option v-for="m in addFormModelList" :key="m" :value="m">{{ m }}</option>
                                </datalist>
                                <small v-if="addFormRecommendedModel">推荐: {{ addFormRecommendedModel }}</small>
                            </div>
                    </div>
                    <DialogFooter>
                        <Button size="sm" @click="showAddVectorizerDialog = false">取消</Button>
                        <Button size="sm" variant="default"
                            :disabled="addingVectorizer || !addVectorizerForm.provider_key || !addVectorizerForm.model_name"
                            @click="handleAddVectorizer">
                            {{ addingVectorizer ? '添加中...' : '确定' }}
                        </Button>
                    </DialogFooter>
          </DialogContent>
        </Dialog>

        <!-- 迁移对话框 -->
        <Dialog v-model:open="showMigrateDialog">
          <DialogContent class="max-w-[480px]">
            <DialogHeader>
              <DialogTitle>迁移向量数据</DialogTitle>
            </DialogHeader>
                    <p class="migrate-desc">将「{{ migrateFromKey }}」中的向量数据迁移到另一个向量化器。</p>
                    <div class="form-grid">
                            <div class="field field--full">
                                <label>迁移目标向量化器 <em>*</em></label>
                                <CustomSelect v-model="migrateToKey" :options="migrateTargetOptions"
                                    placeholder="-- 选择目标 --" />
                            </div>
                    </div>
                    <DialogFooter>
                        <Button size="sm" @click="showMigrateDialog = false">取消</Button>
                        <Button size="sm" variant="default" :disabled="migrating || !migrateToKey" @click="handleMigrate">
                            {{ migrating ? '迁移中...' : '开始迁移' }}
                        </Button>
                    </DialogFooter>
          </DialogContent>
        </Dialog>

        <!-- 新增重排序器对话框 -->
        <Dialog v-model:open="showAddRerankerDialog">
          <DialogContent class="max-w-[480px]">
            <DialogHeader>
              <DialogTitle>新增重排序器</DialogTitle>
              <DialogDescription>模型模式直接引用模型 Provider，模型、Endpoint 与 API Key 始终跟随 Provider 当前配置。</DialogDescription>
            </DialogHeader>
                    <FieldGroup>
                        <Field>
                            <FieldLabel>模式 <em>*</em></FieldLabel>
                            <CustomSelect v-model="addRerankerForm.mode" :options="rerankerModeSelectOptions" />
                        </Field>
                        <Field v-if="addRerankerForm.mode === 'model'">
                            <FieldLabel>Rerank Provider <em>*</em></FieldLabel>
                            <CustomSelect
                                v-model="addRerankerForm.provider_key"
                                :options="availableRerankProviderSelectOptions"
                                :disabled="availableRerankProviderSelectOptions.length === 0"
                                placeholder="-- 选择已就绪的 Rerank Provider --"
                            />
                            <FieldDescription v-if="selectedRerankProvider">
                                模型 {{ selectedRerankModel }} · {{ selectedRerankProvider.api_endpoint }}
                            </FieldDescription>
                            <FieldDescription v-else-if="availableRerankProviderSelectOptions.length === 0 && !hasReadyRerankProviders">
                                请先在“模型 Provider 管理”中配置 Rerank 模型、Endpoint 和 API Key。
                            </FieldDescription>
                            <FieldDescription v-else-if="availableRerankProviderSelectOptions.length === 0">所有已就绪的 Rerank Provider 都已接入知识库。</FieldDescription>
                            <FieldDescription v-else>知识库不会保存 Provider 的模型、Endpoint 或密钥副本。</FieldDescription>
                        </Field>
                    </FieldGroup>
                    <DialogFooter>
                        <Button size="sm" @click="showAddRerankerDialog = false">取消</Button>
                        <Button size="sm" variant="default"
                            :disabled="addingReranker || !addRerankerFormValid"
                            @click="handleAddReranker">
                            {{ addingReranker ? '添加中...' : '确定' }}
                        </Button>
                    </DialogFooter>
          </DialogContent>
        </Dialog>
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import CustomSelect from '../ui/CustomSelect.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import SegmentedControl from '../SegmentedControl.vue';

const props = defineProps({ context: { type: Object, required: true } });
const { activeTab, showMarkdownPreview, previewFile, previewAnchor, globalLoading, tabs, kpiItems, activeVectorizerDisplay, isDragOver, fileInputRef, handleFileDrop, triggerFileInput, handleFileSelect, mergedFilesLoading, refreshFilesAndStatus, filterCollection, collectionSelectOptions, showIndexDialog, fileStatusVectorizers, uploadedFiles, mergedFileList, formatFileSize, formatTime, openMarkdownPreview, openSearchTest, indexingFileKey, handleIndexFileWithVectorizer, downloadFile, handleDeleteMergedFile, searchCollection, searchResults, searchQuery, handleSearch, searchLoading, searchTopK, searchMode, searchModeOptions, searchRerank, searchRerankerOptions, searchRerankSelection, resultSimilarity, scoreClass, resultSimilarityLabel, searchPerformed, vectorizersLoading, vectorizers, openAddVectorizerDialog, handleActivateVectorizer, activatingVectorizer, openMigrateDialog, deletingVectorizer, handleDeleteVectorizer, rerankersLoading, rerankers, openAddRerankerDialog, activeRerankerDisplay, activatingReranker, deletingReranker, handleActivateReranker, handleDeleteReranker, indexModes, indexMode, indexUploadFile, indexFileInputRef, triggerIndexFileInput, handleIndexFileSelect, handleIndexFileDrop, indexForm, uploadedFileSelectOptions, loadUploadedFilesIfEmpty, autoSetCollectionName, documentTypeOptions, indexing, handleIndexDocument, showAddVectorizerDialog, addVectorizerForm, availableProviderSelectOptions, onAddFormProviderChange, addFormRecommendedModel, addFormModelList, addingVectorizer, showMigrateDialog, migrateFromKey, migrateToKey, migrateTargetOptions, migrating, handleMigrate, showAddRerankerDialog, addRerankerForm, rerankerModeSelectOptions, availableRerankProviderSelectOptions, selectedRerankProvider, selectedRerankModel, hasReadyRerankProviders, addRerankerFormValid, addingReranker, handleAddReranker, handleMarkdownNotify, handlePreviewCitation, showToast, handleAddVectorizer } = props.context;
</script>

<style scoped>

.mini-upload-zone {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--radius-md);
    border: 1px dashed var(--color-border);
    background: var(--color-bg-secondary);
    cursor: pointer;
    min-height: 44px;
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    transition: all 0.2s;
}

.mini-upload-zone:hover {
    border-color: var(--color-brand-accent);
    color: var(--color-text-primary);
}
.form-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--spacing-md);
}

.field--full {
    grid-column: 1 / -1;
}

.field {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
}

.field>label {
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
    letter-spacing: 0.02em;
}

.field em {
    color: var(--color-error);
    font-style: normal;
}

.field small {
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
}

.field input, .field textarea {
    width: 100%;
    height: 40px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text-primary);
    padding: 0 12px;
    font: inherit;
    font-size: var(--font-size-sm);
    transition: border-color 0.2s;
}

.field textarea {
    resize: vertical;
    min-height: 80px;
    height: auto;
    padding: 10px 12px;
}

.field input:focus, .field textarea:focus {
    outline: none;
    border-color: var(--color-border-focus);
    box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}

.field input:hover, .field textarea:hover {
    border-color: var(--color-border-hover);
}

.field input::placeholder, .field textarea::placeholder {
    color: var(--color-text-muted);
}

.input-with-btn {
    display: flex;
    gap: var(--spacing-xs);
}

.input-with-btn input {
    flex: 1;
}
.migrate-desc {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    margin: 0 0 var(--spacing-md) 0;
    padding: 10px 14px;
    border-radius: var(--radius-md);
    background: var(--color-bg-tertiary);
}
@media (max-width: 720px) {
    .form-grid {
        grid-template-columns: 1fr;
    }
}
@media (max-width: 480px) {
    .index-mode-tabs {
        width: 100%;
        display: flex;
    }

    .mode-tab {
        flex: 1;
        text-align: center;
        padding: 7px 4px;
        font-size: 12px;
    }
}
</style>
