import { computed, h, onMounted, reactive, ref } from 'vue';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { normalizeModelList } from '../utils/modelList.js';
import { parseKnowledgeSearchFilters } from '../utils/knowledgeSearch.js';
import { showToast as showToastMessage } from '../utils/toast.js';
import {
    activateVectorizer,
    activateReranker,
    addReranker,
    addVectorizer,
    deleteFile,
    deleteReranker,
    deleteVectorizer,
    getFileStatus,
    indexFile,
    ingestFileToCollection,
    listFiles,
    listRerankers,
    listVectorizers,
    migrateVectorizer,
    searchVectors,
    uploadFiles,
} from '../api/knowledgeBase';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';

export function useKnowledgeBaseManager() {
  const toast = useToast();
  const { confirm } = useConfirm();
  const dictStore = useDictionariesStore();

  const SVG = { xmlns: 'http://www.w3.org/2000/svg', width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const IconFiles = () => h('svg', SVG, [h('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }), h('polyline', { points: '14 2 14 8 20 8' })]);
  const IconIndexed = () => h('svg', SVG, [h('path', { d: 'M12 2L2 7l10 5 10-5-10-5z' }), h('path', { d: 'M2 17l10 5 10-5' }), h('path', { d: 'M2 12l10 5 10-5' })]);
  const IconVectorizers = () => h('svg', SVG, [h('ellipse', { cx: 12, cy: 5, rx: 9, ry: 3 }), h('path', { d: 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3' }), h('path', { d: 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5' })]);
  const IconRerankers = () => h('svg', SVG, [h('line', { x1: 4, y1: 9, x2: 20, y2: 9 }), h('line', { x1: 4, y1: 15, x2: 20, y2: 15 }), h('line', { x1: 10, y1: 3, x2: 8, y2: 21 }), h('line', { x1: 16, y1: 3, x2: 14, y2: 21 })]);

  const showToast = (message, type = 'error') => showToastMessage(toast, message, type);

  // ── Tab ───────────────────────────────────────────────────
  const activeTab = ref('store');
  const showMarkdownPreview = ref(false);
  const previewFile = ref(null);
  const previewAnchor = ref({ char_start: undefined, heading: '' });
  const globalLoading = ref(false);

  const tabs = computed(() => [
      {
          id: 'store', label: '文件与索引',
          badge: uploadedFiles.value.length || null,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
      },
      {
          id: 'vectorizers', label: '向量化器',
          badge: vectorizers.value.length || null,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
      },
      {
          id: 'rerankers', label: '重排序器',
          badge: rerankers.value.length || null,
          icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>`,
      },
      {
          id: 'search', label: '搜索测试',
          icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
      },
  ]);

  // ── 统计 ──────────────────────────────────────────────────
  const kpiItems = computed(() => [
      { key: 'files', label: '文件总数', value: uploadedFiles.value.length, icon: IconFiles },
      { key: 'indexed', label: '已索引文件', value: fileList.value.length, icon: IconIndexed },
      { key: 'vectorizers', label: '向量化器', value: vectorizers.value.length, icon: IconVectorizers },
      { key: 'rerankers', label: '重排序器', value: rerankers.value.length, icon: IconRerankers },
  ]);

  const activeVectorizer = computed(() => vectorizers.value.find(v => v.is_active));

  const activeVectorizerDisplay = computed(() => {
      const active = activeVectorizer.value;
      if (!active) return '';
      return active.model_name ? `${active.model_name} (${active.provider_key})` : active.vectorizer_key;
  });

  // ── 文件管理 ──────────────────────────────────────────────
  const uploadedFiles = ref([]);
  const filesLoading = ref(false);
  const deletingUploadedFile = ref(null);
  const isDragOver = ref(false);
  const fileInputRef = ref(null);
  const uploadedFileSelectOptions = computed(() =>
      uploadedFiles.value.map(f => ({
          value: f.id,
          label: `${f.original_name || f.filename} (${formatFileSize(f.size)})`,
      }))
  );

  async function loadUploadedFiles() {
      filesLoading.value = true;
      try {
          const res = await listFiles();
          uploadedFiles.value = res.files || [];
      } catch (e) {
          showToast(e.message || '加载文件列表失败');
      } finally {
          filesLoading.value = false;
      }
  }

  async function loadUploadedFilesIfEmpty() {
      if (uploadedFiles.value.length === 0) await loadUploadedFiles();
  }

  function triggerFileInput() { fileInputRef.value?.click(); }
  function handleFileSelect(e) {
      const files = e.target.files;
      if (files?.length) uploadSelectedFiles(files);
  }
  function handleFileDrop(e) {
      isDragOver.value = false;
      const files = e.dataTransfer?.files;
      if (files?.length) uploadSelectedFiles(files);
  }
  async function uploadSelectedFiles(fileList_) {
      const fd = new FormData();
      for (const f of fileList_) fd.append('files', f);
      try {
          const res = await uploadFiles(fd);
          showToast(`成功上传 ${res.files?.length || 0} 个文件`, 'success');
          await loadUploadedFiles();
      } catch (e) {
          showToast(e.message || '上传失败');
      }
  }
  function downloadFile(file) {
      window.open(`/api/knowledge-bases/files/${encodeURIComponent(file.id)}/download`, '_blank');
  }
  function openMarkdownPreview(file) {
      previewAnchor.value = { char_start: undefined, heading: '' };
      previewFile.value = file;
      showMarkdownPreview.value = true;
  }
  function handlePreviewCitation(citation) {
      const target = uploadedFiles.value.find(file => file.id === citation?.file_id);
      if (!target) return showToast('引用文件不存在', 'error');
      previewAnchor.value = { char_start: Number.isFinite(citation?.char_start) ? citation.char_start : undefined, heading: citation?.heading || '' };
      previewFile.value = target;
      showMarkdownPreview.value = false;
      requestAnimationFrame(() => { showMarkdownPreview.value = true; });
  }
  function handleMarkdownNotify(payload) {
      showToast(payload?.message || '操作失败', payload?.type || 'error');
  }
  async function handleDeleteUploadedFile(file) {
      const ok = await confirm({ message: `确定删除文件“${file.original_name || file.filename}”？`, confirmText: '删除', danger: true });
      if (!ok) return;
      deletingUploadedFile.value = file.id;
      try {
          await deleteFile(file.id);
          showToast('删除成功', 'success');
          await loadUploadedFiles();
      } catch (e) {
          showToast(e.message || '删除失败');
      } finally {
          deletingUploadedFile.value = null;
      }
  }

  // ── 知识库矩阵 ────────────────────────────────────────────
  const fileList = ref([]);
  const fileStatusVectorizers = ref([]);
  const storeLoading = ref(false);
  const indexingFileKey = ref('');
  const deletingFileId = ref(null);
  const filterCollection = ref('');

  const collectionOptions = computed(() => {
      const s = new Set(fileList.value.map(f => f.collection).filter(Boolean));
      return [...s].sort();
  });
  // CustomSelect 所需选项数组
  const collectionSelectOptions = computed(() => [
      { value: '', label: '全部集合' },
      ...collectionOptions.value.map(c => ({ value: c, label: c })),
  ]);
  const mergedFilesLoading = computed(() => filesLoading.value || storeLoading.value);
  const mergedFileList = computed(() => {
      const indexRowsByFile = new Map();
      for (const indexRow of fileList.value) {
          const rows = indexRowsByFile.get(indexRow.file_id) || [];
          rows.push(indexRow);
          indexRowsByFile.set(indexRow.file_id, rows);
      }

      return uploadedFiles.value
          .map(file => {
              const indexRows = indexRowsByFile.get(file.id) || [];
              const collections = [...new Set(indexRows.map(row => row.collection).filter(Boolean))].sort();
              const vectorizerStatus = {};

              for (const vectorizer of fileStatusVectorizers.value) {
                  const indexedCollections = [...new Set(indexRows
                      .filter(row => row.vectorizer_status?.[vectorizer.vectorizer_key] === '已索引')
                      .map(row => row.collection)
                      .filter(Boolean))].sort();
                  vectorizerStatus[vectorizer.vectorizer_key] = {
                      indexed: indexedCollections.length > 0,
                      collections: indexedCollections,
                  };
              }

              return {
                  ...file,
                  file_id: file.id,
                  file_name: file.original_name || file.filename,
                  collection: filterCollection.value || collections[0] || 'documents',
                  collections,
                  search_collection: filterCollection.value || collections[0] || '',
                  has_index: indexRows.length > 0,
                  index_rows: indexRows,
                  vectorizer_status: vectorizerStatus,
              };
          })
          .filter(file => !filterCollection.value || file.collections.includes(filterCollection.value));
  });

  async function refreshFilesAndStatus() {
      await Promise.all([loadUploadedFiles(), refreshFileStatus()]);
  }

  async function refreshFileStatus() {
      storeLoading.value = true;
      try {
          const res = await getFileStatus();
          if (res.success && res.data) {
              fileList.value = res.data.files || [];
              fileStatusVectorizers.value = res.data.vectorizers || [];
          } else {
              fileList.value = [];
              fileStatusVectorizers.value = [];
          }
      } catch (e) {
          showToast(e.message || '获取索引状态失败');
          fileList.value = [];
          fileStatusVectorizers.value = [];
      } finally {
          storeLoading.value = false;
      }
  }

  async function handleIndexFileWithVectorizer(row, vectorizerKey) {
      const key = row.file_id + ':' + vectorizerKey;
      indexingFileKey.value = key;
      try {
          const res = await indexFile({
              collection: row.collection,
              file_id: row.file_id,
              vectorizer_key: vectorizerKey,
          });
          if (res.success) {
              showToast(`索引成功，共 ${res.data?.indexed_chunks ?? 0} 个分块`, 'success');
              await refreshFileStatus();
          } else {
              showToast(res.message || '索引失败');
          }
      } catch (e) {
          showToast(e.message || '索引失败');
      } finally {
          indexingFileKey.value = '';
      }
  }

  async function handleDeleteMergedFile(row) {
      if (!row.has_index) {
          await handleDeleteUploadedFile(row);
          return;
      }

      const ok = await confirm({ message: `确定删除“${row.file_name}”的文件及全部集合中的索引？此操作不可恢复。`, confirmText: '删除', danger: true });
      if (!ok) return;
      deletingFileId.value = row.file_id;
      try {
          const res = await deleteFile(row.file_id);
          showToast(`已删除文件及 ${res.deleted_chunks ?? 0} 个分块`, 'success');
          await refreshFilesAndStatus();
      } catch (e) {
          showToast(e.message || '删除失败');
          await refreshFilesAndStatus();
      } finally {
          deletingFileId.value = null;
      }
  }

  // ── 索引新文档 ────────────────────────────────────────────
  const showIndexDialog = ref(false);
  const indexing = ref(false);
  const indexMode = ref('select');
  const indexModes = [
      { id: 'select', label: '📂 选择已上传文件' },
      { id: 'upload', label: '📁 上传新文件' },
      { id: 'text', label: '✏️ 直接输入文本' },
  ];
  const indexUploadFile = ref(null);
  const indexFileInputRef = ref(null);

  const documentTypeToCollection = {
      general: 'documents',
      emergency_plan: 'emergency_plans',
      report: 'reports',
      manual: 'manuals',
  };
  const documentTypeOptions = [
      { value: 'general', label: '通用文档' },
      { value: 'emergency_plan', label: '应急预案' },
      { value: 'report', label: '技术报告' },
      { value: 'manual', label: '操作手册' },
  ];

  const indexForm = ref({
      collection_name: 'documents',
      document_id: '',
      text: '',
      file_id: '',
      metadata: { source: '', document_type: 'general' },
      chunk_size: 500,
      overlap: 50,
  });

  function autoSetCollectionName() {
      const t = indexForm.value.metadata.document_type;
      indexForm.value.collection_name = documentTypeToCollection[t] || 'documents';
  }
  function triggerIndexFileInput() { indexFileInputRef.value?.click(); }
  function handleIndexFileSelect(e) { indexUploadFile.value = e.target.files?.[0] || null; }
  function handleIndexFileDrop(e) { indexUploadFile.value = e.dataTransfer?.files?.[0] || null; }

  function resetIndexForm() {
      indexForm.value = {
          collection_name: 'documents', document_id: '', text: '', file_id: '',
          metadata: { source: '', document_type: 'general' }, chunk_size: 500, overlap: 50,
      };
      indexUploadFile.value = null;
      indexMode.value = 'select';
  }

  async function handleIndexDocument() {
      indexing.value = true;
      try {
          let res;
          if (indexMode.value === 'upload') {
              if (!indexUploadFile.value) { showToast('请选择要上传的文件'); return; }
              const fd = new FormData();
              fd.append('files', indexUploadFile.value);
              const uploadRes = await uploadFiles(fd);
              const fileId = uploadRes.files?.[0]?.id;
              if (!fileId) throw new Error('上传成功但未返回文件ID');
              res = await ingestFileToCollection({
                  file_id: fileId,
                  collection_name: indexForm.value.collection_name,
                  document_id: indexForm.value.document_id || indexUploadFile.value.name,
                  metadata: indexForm.value.metadata,
                  chunk_size: indexForm.value.chunk_size,
                  overlap: indexForm.value.overlap,
              });
          } else if (indexMode.value === 'select') {
              if (!indexForm.value.file_id) { showToast('请选择文件'); return; }
              res = await ingestFileToCollection({
                  file_id: indexForm.value.file_id,
                  collection_name: indexForm.value.collection_name,
                  document_id: indexForm.value.document_id || indexForm.value.file_id,
                  metadata: indexForm.value.metadata,
                  chunk_size: indexForm.value.chunk_size,
                  overlap: indexForm.value.overlap,
              });
          } else {
              if (!indexForm.value.document_id || !indexForm.value.text) {
                  showToast('请填写文档ID和内容'); return;
              }
              res = await ingestFileToCollection(indexForm.value);
          }
          const data = res?.data || res;
          const chunks = data?.indexed_chunks ?? '?';
          showToast(`索引成功，生成 ${chunks} 个分块`, 'success');
          showIndexDialog.value = false;
          resetIndexForm();
          await Promise.all([refreshFileStatus(), loadUploadedFiles()]);
      } catch (e) {
          showToast(e.message || '索引失败');
      } finally {
          indexing.value = false;
      }
  }

  // ── 向量化器 ──────────────────────────────────────────────
  const vectorizers = ref([]);
  const vectorizersLoading = ref(false);
  const activatingVectorizer = ref(null);
  const deletingVectorizer = ref(null);

  async function refreshVectorizers() {
      vectorizersLoading.value = true;
      try {
          const res = await listVectorizers();
          vectorizers.value = Array.isArray(res.data) ? res.data : (res.vectorizers || []);
      } catch (e) {
          showToast(e.message || '加载向量化器失败');
          vectorizers.value = [];
      } finally {
          vectorizersLoading.value = false;
      }
  }

  async function handleActivateVectorizer(key) {
      activatingVectorizer.value = key;
      try {
          const res = await activateVectorizer(key);
          if (res.success) {
              showToast('已切换激活向量化器', 'success');
              await refreshVectorizers();
          } else {
              showToast(res.message || '激活失败');
          }
      } catch (e) {
          showToast(e.message || '激活失败');
      } finally {
          activatingVectorizer.value = null;
      }
  }

  async function handleDeleteVectorizer(key) {
      const ok = await confirm({ message: `确定删除向量化器“${key}”？将同时删除其向量数据。`, confirmText: '删除', danger: true });
      if (!ok) return;
      deletingVectorizer.value = key;
      try {
          const res = await deleteVectorizer(key);
          if (res.success) {
              showToast('已删除向量化器', 'success');
              await refreshVectorizers();
          } else {
              showToast(res.message || '删除失败');
          }
      } catch (e) {
          showToast(e.message || '删除失败');
      } finally {
          deletingVectorizer.value = null;
      }
  }

  // ── 新增向量化器（Provider 选择模式）────────────────────────
  const showAddVectorizerDialog = ref(false);
  const addingVectorizer = ref(false);
  const addVectorizerForm = reactive({ provider_key: '', model_name: '' });
  const availableProviders = ref([]);
  const availableRerankProviders = ref([]);
  const addFormRecommendedModel = ref('');
  const addFormModelList = ref([]);
  const availableProviderSelectOptions = computed(() =>
      availableProviders.value.map(p => ({ value: p.key, label: `${p.name} (${p.provider_type})` }))
  );

  async function openAddVectorizerDialog() {
      showAddVectorizerDialog.value = true;
      if (availableProviders.value.length === 0) await loadProviders();
  }

  async function loadProviders(force = false) {
      try {
          const providers = await dictStore.ensureProviders(force);
          availableProviders.value = providers.filter(p => {
              const emb = p.model_map?.embedding;
              const embeddingModels = normalizeModelList(emb);
              return embeddingModels.length > 0 || p.models?.length > 0;
          });
          availableRerankProviders.value = providers.filter(p => (
              normalizeModelList(p.model_map?.rerank).length > 0
              && Boolean(String(p.api_endpoint || '').trim())
              && p.api_key_configured === true
          ));
      } catch (e) {
          showToast('加载 Provider 列表失败');
      }
  }

  function onAddFormProviderChange(key) {
      const p = availableProviders.value.find(x => x.key === key);
      if (!p) {
          addFormRecommendedModel.value = '';
          addFormModelList.value = [];
          return;
      }
      const emb = p.model_map?.embedding;
      addFormRecommendedModel.value = normalizeModelList(emb)[0] || '';
      const all = new Set((p.models || []).map(item => String(item || '').trim()).filter(Boolean));
      if (p.model_map) {
          Object.values(p.model_map).forEach(m => {
              normalizeModelList(m).forEach(model => all.add(model));
          });
      }
      addFormModelList.value = [...all];
      if (!addVectorizerForm.model_name && addFormRecommendedModel.value) {
          addVectorizerForm.model_name = addFormRecommendedModel.value;
      }
  }

  async function handleAddVectorizer() {
      if (!addVectorizerForm.provider_key || !addVectorizerForm.model_name) {
          showToast('请选择 Provider 和模型');
          return;
      }
      addingVectorizer.value = true;
      try {
          const res = await addVectorizer({
              provider_key: addVectorizerForm.provider_key,
              model_name: addVectorizerForm.model_name.trim(),
          });
          if (res.success) {
              showToast('已添加向量化器', 'success');
              showAddVectorizerDialog.value = false;
              addVectorizerForm.provider_key = '';
              addVectorizerForm.model_name = '';
              addFormRecommendedModel.value = '';
              addFormModelList.value = [];
              await refreshVectorizers();
          } else {
              showToast(res.message || '添加失败');
          }
      } catch (e) {
          showToast(e.message || '添加失败');
      } finally {
          addingVectorizer.value = false;
      }
  }

  // ── 迁移 ──────────────────────────────────────────────────
  const showMigrateDialog = ref(false);
  const migrateFromKey = ref('');
  const migrateToKey = ref('');
  const migrating = ref(false);
  const migrateTargetOptions = computed(() =>
      vectorizers.value
          .filter(x => x.vectorizer_key !== migrateFromKey.value)
          .map(v => ({ value: v.vectorizer_key, label: `${v.vectorizer_key} (${v.model_name})` }))
  );

  function openMigrateDialog(v) {
      migrateFromKey.value = v.vectorizer_key;
      migrateToKey.value = '';
      showMigrateDialog.value = true;
  }

  async function handleMigrate() {
      if (!migrateToKey.value) { showToast('请选择目标向量化器'); return; }
      migrating.value = true;
      try {
          const res = await migrateVectorizer({ from_key: migrateFromKey.value, to_key: migrateToKey.value });
          if (res.success) {
              showToast('迁移成功', 'success');
              showMigrateDialog.value = false;
              await Promise.all([refreshVectorizers(), refreshFileStatus()]);
          } else {
              showToast(res.message || '迁移失败');
          }
      } catch (e) {
          showToast(e.message || '迁移失败');
      } finally {
          migrating.value = false;
      }
  }

  // ── 重排序器管理 ────────────────────────────────────────────
  const rerankers = ref([]);
  const rerankersLoading = ref(false);
  const activatingReranker = ref('');
  const deletingReranker = ref('');
  const showAddRerankerDialog = ref(false);
  const addingReranker = ref(false);
  const addRerankerForm = reactive({
      mode: 'model',
      provider_key: '',
  });

  const rerankerModeSelectOptions = [
      { value: 'model', label: '模型 Provider' },
      { value: 'lexical', label: '本地 (BM25)' },
      { value: 'none', label: '无 (直通)' },
  ];

  const availableRerankProviderSelectOptions = computed(() => (
      availableRerankProviders.value
          .filter(provider => !rerankers.value.some(reranker => (
              reranker.mode === 'model' && reranker.provider_key === provider.key
          )))
          .map(provider => ({
              value: provider.key,
              label: `${provider.name} · ${normalizeModelList(provider.model_map?.rerank)[0]}`,
          }))
  ));
  const selectedRerankProvider = computed(() => (
      availableRerankProviders.value.find(provider => provider.key === addRerankerForm.provider_key) || null
  ));
  const selectedRerankModel = computed(() => (
      normalizeModelList(selectedRerankProvider.value?.model_map?.rerank)[0] || ''
  ));
  const hasReadyRerankProviders = computed(() => availableRerankProviders.value.length > 0);

  const addRerankerFormValid = computed(() => {
      if (!addRerankerForm.mode) return false;
      if (addRerankerForm.mode === 'model') {
          return !!addRerankerForm.provider_key;
      }
      return true;
  });

  const activeReranker = computed(() => rerankers.value.find(r => r.is_active));
  const activeRerankerDisplay = computed(() => {
      const r = activeReranker.value;
      if (!r) return '';
      if (r.mode === 'model') return `${r.reranker_key} (${r.model_name || r.provider_key})`;
      return r.reranker_key;
  });

  async function refreshRerankers() {
      rerankersLoading.value = true;
      try {
          const res = await listRerankers();
          rerankers.value = res.data || [];
      } catch (e) {
          showToast(e.message || '加载重排序器失败');
      } finally {
          rerankersLoading.value = false;
      }
  }

  async function openAddRerankerDialog() {
      addRerankerForm.mode = 'model';
      addRerankerForm.provider_key = '';
      showAddRerankerDialog.value = true;
      await loadProviders(true);
  }

  async function handleAddReranker() {
      addingReranker.value = true;
      try {
          const body = { mode: addRerankerForm.mode };
          if (addRerankerForm.mode === 'model') {
              body.provider_key = addRerankerForm.provider_key;
          }
          await addReranker(body);
          showAddRerankerDialog.value = false;
          showToast('重排序器已添加', 'success');
          await refreshRerankers();
      } catch (e) {
          showToast(e.message || '添加重排序器失败');
      } finally {
          addingReranker.value = false;
      }
  }

  async function handleActivateReranker(key) {
      activatingReranker.value = key;
      try {
          await activateReranker(key);
          showToast('重排序器已激活', 'success');
          await refreshRerankers();
      } catch (e) {
          showToast(e.message || '激活重排序器失败');
      } finally {
          activatingReranker.value = '';
      }
  }

  async function handleDeleteReranker(key) {
      const ok = await confirm({ message: `确定删除重排序器“${key}”？`, confirmText: '删除', danger: true });
      if (!ok) return;
      deletingReranker.value = key;
      try {
          await deleteReranker(key);
          showToast('重排序器已删除', 'success');
          await refreshRerankers();
      } catch (e) {
          showToast(e.message || '删除重排序器失败');
      } finally {
          deletingReranker.value = '';
      }
  }

  // ── 搜索测试 ──────────────────────────────────────────────
  const searchQuery = ref('');
  const searchTopK = ref(5);
  const searchMode = ref('hybrid');
  const searchRerank = ref(false);
  const searchRerankSelection = ref('');
  const searchFiltersText = ref('');
  const searchModeOptions = [
      { value: 'hybrid', label: '混合' },
      { value: 'vector', label: '向量' },
  ];
  const searchRerankerOptions = computed(() => {
      return rerankers.value.map(r => ({
          value: r.reranker_key,
          label: `${r.reranker_key} (${r.mode === 'model' ? r.model_name || r.provider_key : r.mode})${r.provider_managed && !r.provider_available ? ' · Provider 不可用' : ''}`,
      }));
  });
  const searchCollection = ref('');
  const searchLoading = ref(false);
  const searchResults = ref([]);
  const searchResponse = ref(null);
  const searchPerformed = ref(false);

  function openSearchTest(collection) {
      searchCollection.value = collection;
      searchResults.value = [];
      searchResponse.value = null;
      searchPerformed.value = false;
      searchQuery.value = '';
      searchFiltersText.value = '';
      activeTab.value = 'search';
  }

  async function handleSearch() {
      if (!searchQuery.value.trim()) { showToast('请输入搜索关键词'); return; }
      let filters;
      try {
          filters = parseKnowledgeSearchFilters(searchFiltersText.value);
      } catch (error) {
          showToast(error.message, 'warning');
          return;
      }
      searchLoading.value = true;
      searchPerformed.value = true;
      searchResults.value = [];
      searchResponse.value = null;
      try {
          const topK = Number(searchTopK.value) || 5;
          const shouldRerank = searchRerank.value;
          const res = await searchVectors({
              query: searchQuery.value,
              top_k: topK,
              collection: searchCollection.value || undefined,
              search_mode: searchMode.value,
              filters,
              rerank: shouldRerank,
              rerank_top_k: shouldRerank ? Math.max(topK * 3, 10) : undefined,
              reranker_key: shouldRerank ? (searchRerankSelection.value || undefined) : undefined,
          });
          const payload = res.data || res || {};
          searchResponse.value = payload;
          searchResults.value = payload.results || [];
          if (payload.rerank_error) {
              showToast(`重排序未按预期执行：${payload.rerank_error}`, 'warning');
          }
          if (searchResults.value.length === 0) showToast('未找到相关结果', 'warning');
      } catch (e) {
          showToast(e.message || '搜索失败');
      } finally {
          searchLoading.value = false;
      }
  }

  function scoreClass(score) {
      if (score == null) return 'score-poor';
      if (score > 0.8) return 'score-high';
      if (score > 0.6) return 'score-mid';
      if (score > 0.4) return 'score-low';
      return 'score-poor';
  }

  function resultSimilarity(result) {
      const value = Number(result?.final_score ?? result?.score ?? result?.vector_score ?? result?.similarity);
      return Number.isFinite(value) ? value : null;
  }

  function resultSimilarityLabel(result) {
      const score = resultSimilarity(result);
      if (score == null) return '得分 -';
      if (result?.score_type === 'vector') return `向量 ${(score * 100).toFixed(2)}%`;
      if (result?.score_type === 'hybrid') return `融合 ${formatScore(score)}`;
      if (result?.score_type === 'rerank') return `重排 ${formatScore(score)}`;
      return `得分 ${formatScore(score)}`;
  }

  function formatScore(score) {
      const value = Number(score);
      if (!Number.isFinite(value)) return '-';
      return value.toFixed(4);
  }

  // ── 工具函数 ──────────────────────────────────────────────
  function formatFileSize(bytes) {
      if (!bytes) return '-';
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes, i = 0;
      while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
      return `${size.toFixed(2)} ${units[i]}`;
  }
  function formatTime(ts) {
      if (!ts) return '-';
      return new Date(ts).toLocaleString('zh-CN');
  }

  // ── 全局刷新 & 初始化 ─────────────────────────────────────
  async function refreshAll() {
      globalLoading.value = true;
      await Promise.all([loadUploadedFiles(), refreshFileStatus(), refreshVectorizers(), refreshRerankers()]);
      globalLoading.value = false;
  }

  onMounted(() => {
      refreshAll();
  });

    return { context: { activeTab, showMarkdownPreview, previewFile, previewAnchor, globalLoading, refreshAll, tabs, kpiItems, deletingFileId, deletingUploadedFile, formatScore, refreshVectorizers, refreshRerankers, handleAddVectorizer, activeVectorizerDisplay, isDragOver, fileInputRef, handleFileDrop, triggerFileInput, handleFileSelect, mergedFilesLoading, refreshFilesAndStatus, filterCollection, collectionSelectOptions, showIndexDialog, fileStatusVectorizers, uploadedFiles, mergedFileList, formatFileSize, formatTime, openMarkdownPreview, openSearchTest, indexingFileKey, handleIndexFileWithVectorizer, downloadFile, handleDeleteMergedFile, searchCollection, searchResults, searchResponse, searchQuery, handleSearch, searchLoading, searchTopK, searchMode, searchModeOptions, searchRerank, searchRerankerOptions, searchRerankSelection, searchFiltersText, resultSimilarity, scoreClass, resultSimilarityLabel, searchPerformed, vectorizersLoading, vectorizers, openAddVectorizerDialog, handleActivateVectorizer, activatingVectorizer, openMigrateDialog, deletingVectorizer, handleDeleteVectorizer, rerankersLoading, rerankers, openAddRerankerDialog, activeRerankerDisplay, activatingReranker, deletingReranker, handleActivateReranker, handleDeleteReranker, indexModes, indexMode, indexFileInputRef, triggerIndexFileInput, handleIndexFileSelect, handleIndexFileDrop, indexForm, uploadedFileSelectOptions, loadUploadedFilesIfEmpty, autoSetCollectionName, documentTypeOptions, indexing, handleIndexDocument, showAddVectorizerDialog, addVectorizerForm, availableProviderSelectOptions, onAddFormProviderChange, addFormRecommendedModel, addFormModelList, addingVectorizer, showMigrateDialog, migrateFromKey, migrateToKey, migrateTargetOptions, migrating, handleMigrate, showAddRerankerDialog, addRerankerForm, rerankerModeSelectOptions, availableRerankProviderSelectOptions, selectedRerankProvider, selectedRerankModel, hasReadyRerankProviders, addRerankerFormValid, addingReranker, handleAddReranker, handleMarkdownNotify, handlePreviewCitation, showToast } };
}
