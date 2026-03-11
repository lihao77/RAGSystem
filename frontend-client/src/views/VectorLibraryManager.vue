<template>
    <div class="vl-page">
        <div class="vl-shell">

            <!-- ── Header ─────────────────────────────────────── -->
            <header class="vl-header glass-card">
                <div class="header-meta">
                    <h1 class="page-title">知识库管理</h1>
                    <p class="page-subtitle">管理文件、向量索引、向量化器配置，构建您的专属知识库。</p>
                </div>
                <div class="header-actions">
                    <button class="btn-action btn-icon" :disabled="globalLoading" @click="refreshAll" title="全局刷新">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                            :class="{ 'spin': globalLoading }">
                            <polyline points="23 4 23 10 17 10" />
                            <polyline points="1 20 1 14 7 14" />
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                        </svg>
                    </button>
                    <button class="btn-back" @click="emit('navigate', '/')">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="19" y1="12" x2="5" y2="12" />
                            <polyline points="12 19 5 12 12 5" />
                        </svg>
                        <span class="btn-text-label">返回聊天</span>
                    </button>
                </div>
            </header>

            <!-- ── 统计卡片 ───────────────────────────────────── -->
            <section class="summary-grid">
                <article class="summary-card glass-card">
                    <div class="summary-icon summary-icon--files">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                        </svg>
                    </div>
                    <div class="summary-body">
                        <span class="summary-label">文件总数</span>
                        <strong class="summary-value">{{ summary.totalFiles }}</strong>
                    </div>
                </article>

                <article class="summary-card glass-card">
                    <div class="summary-icon summary-icon--indexed">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2L2 7l10 5 10-5-10-5z" />
                            <path d="M2 17l10 5 10-5" />
                            <path d="M2 12l10 5 10-5" />
                        </svg>
                    </div>
                    <div class="summary-body">
                        <span class="summary-label">已索引文件</span>
                        <strong class="summary-value summary-value--indexed">{{ summary.indexedFiles }}</strong>
                    </div>
                </article>

                <article class="summary-card glass-card">
                    <div class="summary-icon summary-icon--vectorizers">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                        </svg>
                    </div>
                    <div class="summary-body">
                        <span class="summary-label">向量化器</span>
                        <strong class="summary-value summary-value--vectorizers">{{ summary.vectorizers }}</strong>
                    </div>
                </article>

                <article class="summary-card glass-card">
                    <div class="summary-icon summary-icon--active">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                            <polyline points="22 4 12 14.01 9 11.01" />
                        </svg>
                    </div>
                    <div class="summary-body">
                        <span class="summary-label">激活向量化器</span>
                        <strong class="summary-value summary-value--active" :title="activeVectorizerDisplay">
                            {{ activeVectorizerDisplay || '未设置' }}
                        </strong>
                    </div>
                </article>
            </section>

            <!-- ── Tab 导航 ──────────────────────────────────── -->
            <nav class="tab-nav glass-card">
                <button v-for="tab in tabs" :key="tab.id" class="tab-btn"
                    :class="{ 'tab-btn--active': activeTab === tab.id }" @click="activeTab = tab.id">
                    <span class="tab-icon" v-html="tab.icon"></span>
                    {{ tab.label }}
                    <span v-if="tab.badge != null" class="tab-badge">{{ tab.badge }}</span>
                </button>
            </nav>

            <!-- ── Tab 内容 ──────────────────────────────────── -->
            <section class="tab-content">

                <!-- ══ Tab 1: 向量库管理 ══════════════════════════ -->
                <div v-if="activeTab === 'store'" class="tab-panel">

                    <!-- 当前激活向量化器提示栏 -->
                    <div class="active-bar glass-card">
                        <span class="active-bar__label">当前激活向量化器：</span>
                        <template v-if="activeVectorizerDisplay">
                            <span class="active-bar__tag active-bar__tag--on">{{ activeVectorizerDisplay }}</span>
                        </template>
                        <template v-else>
                            <span class="active-bar__tag active-bar__tag--off">未设置</span>
                            <button class="btn-link" @click="activeTab = 'vectorizers'">前往「向量化器」添加并激活 →</button>
                        </template>
                    </div>

                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <h2 class="section-title">文件 × 向量化器索引矩阵</h2>
                            <p class="section-desc">每行为一个已上传文件，每列为一个向量化器，可逐项建立或查看索引状态。</p>
                        </div>
                        <div class="toolbar-right">
                            <button class="btn-action btn-icon" :disabled="storeLoading" @click="refreshFileStatus"
                                title="刷新索引状态">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                    stroke-linejoin="round" :class="{ 'spin': storeLoading }">
                                    <polyline points="23 4 23 10 17 10" />
                                    <polyline points="1 20 1 14 7 14" />
                                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                </svg>
                            </button>
                            <div class="filter-select-wrap">
                                <CustomSelect v-model="filterCollection" :options="collectionSelectOptions"
                                    placeholder="全部集合" />
                            </div>
                            <button class="btn-primary" @click="showIndexDialog = true">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                    stroke-linejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                索引新文档
                            </button>
                        </div>
                    </div>

                    <!-- 无向量化器警告 -->
                    <div v-if="!storeLoading && fileStatusVectorizers.length === 0 && fileList.length > 0"
                        class="warn-banner">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path
                                d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                            <line x1="12" y1="9" x2="12" y2="13" />
                            <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <span>尚未配置向量化器，请先在「向量化器」Tab 中添加并激活。</span>
                        <button class="btn-link" @click="activeTab = 'vectorizers'">前往配置 →</button>
                    </div>

                    <!-- 矩阵表格 -->
                    <div class="data-table-wrapper glass-card">
                        <div v-if="storeLoading" class="loading-state">
                            <div class="spinner"></div>加载中...
                        </div>
                        <div v-else-if="filteredFileList.length === 0" class="empty-state">
                            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
                                stroke-linejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <p>{{ fileList.length === 0 ? '暂无已索引文件，点击「索引新文档」开始' : '当前集合下无文件，尝试清空筛选' }}</p>
                            <button v-if="fileList.length === 0" class="btn-primary"
                                @click="showIndexDialog = true">索引新文档</button>
                        </div>
                        <div v-else class="table-scroll">
                            <table class="data-table matrix-table">
                                <thead>
                                    <tr>
                                        <th class="col-filename">文件名称</th>
                                        <th class="col-collection">集合</th>
                                        <th class="col-chunks">分块数</th>
                                        <!-- 每个向量化器一列 -->
                                        <th v-for="v in fileStatusVectorizers" :key="v.vectorizer_key"
                                            class="col-vectorizer">
                                            <div class="vectorizer-col-header">
                                                <span class="vc-model" :title="v.model_name">{{ v.model_name }}</span>
                                                <span class="vc-tag vc-tag--provider">{{ v.provider_key }}</span>
                                                <span class="vc-tag vc-tag--dim">{{ v.dimension }}d</span>
                                            </div>
                                        </th>
                                        <th class="col-actions">操作</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="row in filteredFileList" :key="row.file_id">
                                        <td class="cell-filename">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
                                                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                                stroke-linecap="round" stroke-linejoin="round">
                                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                <polyline points="14 2 14 8 20 8" />
                                            </svg>
                                            {{ row.file_name }}
                                        </td>
                                        <td><span class="collection-tag">{{ row.collection }}</span></td>
                                        <td class="text-center">{{ row.chunk_count ?? '-' }}</td>
                                        <!-- 各向量化器状态单元格 -->
                                        <td v-for="v in fileStatusVectorizers" :key="v.vectorizer_key"
                                            class="text-center">
                                            <span v-if="row.vectorizer_status?.[v.vectorizer_key] === '已索引'"
                                                class="status-badge status-badge--success">已索引</span>
                                            <button v-else class="btn-index-cell"
                                                :disabled="indexingFileKey === row.file_id + ':' + v.vectorizer_key"
                                                @click="handleIndexFileWithVectorizer(row, v.vectorizer_key)">
                                                {{ indexingFileKey === row.file_id + ':' + v.vectorizer_key ? '索引中...' :
                                                    '索引' }}
                                            </button>
                                        </td>
                                        <td>
                                            <div class="row-actions">
                                                <button class="act-btn act-btn--secondary"
                                                    @click="openSearchTest(row.collection)" title="测试检索">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                        <circle cx="11" cy="11" r="8" />
                                                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                                    </svg>
                                                </button>
                                                <button class="act-btn act-btn--danger"
                                                    :disabled="deletingFileId === row.file_id"
                                                    @click="handleDeleteIndexedFile(row)" title="删除">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                        viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                        <polyline points="3 6 5 6 21 6" />
                                                        <path
                                                            d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 内嵌检索测试区 -->
                    <div v-if="searchCollection" class="search-inline-card glass-card">
                        <div class="search-inline-header">
                            <span class="search-inline-title">检索测试：{{ searchCollection }}</span>
                            <button class="act-btn act-btn--secondary"
                                @click="searchCollection = ''; searchResults = []">关闭</button>
                        </div>
                        <div class="search-box">
                            <input v-model="searchQuery" class="search-input" placeholder="输入查询文本..."
                                @keyup.enter="handleSearch" />
                            <button class="btn-primary" :disabled="searchLoading" @click="handleSearch">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                    stroke-linejoin="round">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                {{ searchLoading ? '搜索中...' : '搜索' }}
                            </button>
                            <div class="search-option">
                                <label>Top K</label>
                                <input v-model.number="searchTopK" type="number" min="1" max="20"
                                    class="option-input" />
                            </div>
                        </div>
                        <div v-if="searchResults.length > 0" class="search-results">
                            <div v-for="(r, i) in searchResults" :key="i" class="result-item">
                                <div class="result-header">
                                    <span class="result-rank">#{{ i + 1 }}</span>
                                    <span :class="['result-score', scoreClass(r.score ?? r.similarity)]">
                                        {{ ((r.score ?? r.similarity) * 100).toFixed(2) }}%
                                    </span>
                                    <span class="result-source">{{ r.metadata?.source || r.metadata?.document_id ||
                                        '未知来源' }}</span>
                                </div>
                                <div class="result-content">{{ r.content || r.text }}</div>
                                <div v-if="r.metadata?.chunk_index != null" class="result-footer">
                                    分块 {{ r.metadata.chunk_index }} / {{ r.metadata.chunk_total }}
                                </div>
                            </div>
                        </div>
                        <div v-else-if="searchPerformed" class="empty-state" style="padding: var(--spacing-lg)">未找到相关结果
                        </div>
                    </div>
                </div>

                <!-- ══ Tab 2: 文件管理 ════════════════════════════ -->
                <div v-if="activeTab === 'files'" class="tab-panel">
                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <h2 class="section-title">文件管理</h2>
                            <p class="section-desc">上传、查看、删除系统中的文件，上传后可在「向量库管理」中建立索引。</p>
                        </div>
                    </div>

                    <!-- 拖拽上传区 -->
                    <div class="upload-zone glass-card" :class="{ 'upload-zone--dragover': isDragOver }"
                        @dragover.prevent="isDragOver = true" @dragleave.prevent="isDragOver = false"
                        @drop.prevent="handleFileDrop" @click="triggerFileInput">
                        <input ref="fileInputRef" type="file" multiple accept=".pdf,.txt,.md,.doc,.docx,.json"
                            style="display:none" @change="handleFileSelect" />
                        <div class="upload-content">
                            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
                                stroke-linejoin="round" class="upload-icon">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" y1="3" x2="12" y2="15" />
                            </svg>
                            <p class="upload-title">点击或拖拽文件到此处上传</p>
                            <p class="upload-hint">支持 PDF、TXT、MD、DOC、DOCX、JSON，可多选</p>
                        </div>
                    </div>

                    <!-- 文件列表 -->
                    <div class="data-table-wrapper glass-card">
                        <div v-if="filesLoading" class="loading-state">
                            <div class="spinner"></div>加载中...
                        </div>
                        <div v-else-if="uploadedFiles.length === 0" class="empty-state">
                            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
                                stroke-linejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                            </svg>
                            <p>暂无文件，请先上传</p>
                        </div>
                        <table v-else class="data-table">
                            <thead>
                                <tr>
                                    <th>文件名</th>
                                    <th>大小</th>
                                    <th>MIME 类型</th>
                                    <th>上传时间</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="file in uploadedFiles" :key="file.id">
                                    <td class="cell-filename">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"
                                            viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                            stroke-linecap="round" stroke-linejoin="round">
                                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                            <polyline points="14 2 14 8 20 8" />
                                        </svg>
                                        {{ file.original_name || file.filename }}
                                    </td>
                                    <td>{{ formatFileSize(file.size) }}</td>
                                    <td>{{ file.mime || '-' }}</td>
                                    <td>{{ formatTime(file.uploaded_at) }}</td>
                                    <td>
                                        <div class="row-actions">
                                            <button class="act-btn act-btn--secondary" title="下载"
                                                @click="downloadFile(file)">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                                    <polyline points="7 10 12 15 17 10" />
                                                    <line x1="12" y1="15" x2="12" y2="3" />
                                                </svg>
                                            </button>
                                            <button class="act-btn act-btn--danger" title="删除"
                                                :disabled="deletingUploadedFile === file.id"
                                                @click="handleDeleteUploadedFile(file)">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <polyline points="3 6 5 6 21 6" />
                                                    <path
                                                        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                </svg>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ══ Tab 3: 向量化器 ════════════════════════════ -->
                <div v-if="activeTab === 'vectorizers'" class="tab-panel">
                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <h2 class="section-title">向量化器管理</h2>
                            <p class="section-desc">配置多套向量化器，激活后用于新建索引；支持向量化器间的数据迁移。</p>
                        </div>
                        <div class="toolbar-right">
                            <button class="btn-action btn-icon" :disabled="vectorizersLoading"
                                @click="refreshVectorizers" title="刷新向量化器">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                    stroke-linejoin="round" :class="{ 'spin': vectorizersLoading }">
                                    <polyline points="23 4 23 10 17 10" />
                                    <polyline points="1 20 1 14 7 14" />
                                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                                </svg>
                            </button>
                            <button class="btn-primary" @click="openAddVectorizerDialog">
                                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                    stroke-linejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                新增向量化器
                            </button>
                        </div>
                    </div>

                    <div v-if="vectorizersLoading" class="loading-state">
                        <div class="spinner"></div>加载中...
                    </div>
                    <div v-else-if="vectorizers.length === 0" class="empty-state glass-card"
                        style="padding: var(--spacing-xl)">
                        <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
                            stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                            <ellipse cx="12" cy="5" rx="9" ry="3" />
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                        </svg>
                        <p>暂无向量化器，添加后即可在「向量库管理」中建立索引。</p>
                        <button class="btn-primary" @click="openAddVectorizerDialog">新增向量化器</button>
                    </div>
                    <div v-else class="data-table-wrapper glass-card">
                        <table class="data-table">
                            <thead>
                                <tr>
                                    <th>键 (Key)</th>
                                    <th>Provider</th>
                                    <th>模型</th>
                                    <th class="text-center">维度</th>
                                    <th class="text-center">文档数</th>
                                    <th class="text-center">激活</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="v in vectorizers" :key="v.vectorizer_key"
                                    :class="{ 'row-active': v.is_active }">
                                    <td class="font-mono">{{ v.vectorizer_key }}</td>
                                    <td>{{ v.provider_key }}</td>
                                    <td>{{ v.model_name }}</td>
                                    <td class="text-center">{{ v.vector_dimension ?? '-' }}</td>
                                    <td class="text-center">{{ v.vector_count ?? '-' }}</td>
                                    <td class="text-center">
                                        <span v-if="v.is_active" class="status-badge status-badge--success">当前</span>
                                        <button v-else class="btn-link"
                                            :disabled="activatingVectorizer === v.vectorizer_key"
                                            @click="handleActivateVectorizer(v.vectorizer_key)">
                                            {{ activatingVectorizer === v.vectorizer_key ? '激活中...' : '激活' }}
                                        </button>
                                    </td>
                                    <td>
                                        <div class="row-actions">
                                            <button class="act-btn act-btn--secondary"
                                                :disabled="vectorizers.length < 2" @click="openMigrateDialog(v)"
                                                title="迁移数据">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <path d="M5 12h14" />
                                                    <path d="M12 5l7 7-7 7" />
                                                </svg>
                                            </button>
                                            <button class="act-btn act-btn--danger"
                                                :disabled="deletingVectorizer === v.vectorizer_key"
                                                @click="handleDeleteVectorizer(v.vectorizer_key)" title="删除">
                                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13"
                                                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                                    stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                                    <polyline points="3 6 5 6 21 6" />
                                                    <path
                                                        d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                </svg>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ══ Tab 4: 搜索测试 ════════════════════════════ -->
                <div v-if="activeTab === 'search'" class="tab-panel">
                    <div class="section-toolbar">
                        <div class="toolbar-left">
                            <h2 class="section-title">向量搜索测试</h2>
                            <p class="section-desc">输入查询文本，测试向量检索效果。</p>
                        </div>
                    </div>

                    <div class="search-form-card glass-card">
                        <div class="search-box">
                            <input v-model="searchQuery" class="search-input" placeholder="输入搜索关键词..."
                                @keyup.enter="handleSearch" />
                            <button class="btn-primary" :disabled="searchLoading" @click="handleSearch">
                                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                                    fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                    stroke-linejoin="round">
                                    <circle cx="11" cy="11" r="8" />
                                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                {{ searchLoading ? '搜索中...' : '搜索' }}
                            </button>
                        </div>
                        <div class="search-options-row">
                            <div class="search-option">
                                <label>Top K：</label>
                                <input v-model.number="searchTopK" type="number" min="1" max="20"
                                    class="option-input" />
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
                                <span :class="['result-score', scoreClass(r.score ?? r.similarity)]">
                                    相似度 {{ ((r.score ?? r.similarity) * 100).toFixed(2) }}%
                                </span>
                                <span class="result-source">{{ r.metadata?.source || r.metadata?.document_id || '未知来源'
                                }}</span>
                            </div>
                            <div class="result-content">{{ r.content || r.text }}</div>
                            <div v-if="r.metadata?.chunk_index != null" class="result-footer">
                                分块 {{ r.metadata.chunk_index }} / {{ r.metadata.chunk_total }}
                            </div>
                        </div>
                    </div>
                    <div v-else-if="searchPerformed" class="empty-state glass-card" style="padding: var(--spacing-xl)">
                        未找到相关结果
                    </div>
                </div>

            </section>
        </div>

        <!-- ══════════════ 模态框区域 ══════════════════════════ -->

        <!-- 索引新文档对话框 -->
        <Teleport to="body">
            <div v-if="showIndexDialog" class="modal-overlay" @click.self="showIndexDialog = false">
                <div class="modal-shell">
                    <div class="modal-header">
                        <h3>索引新文档</h3>
                        <button class="modal-close" @click="showIndexDialog = false">&times;</button>
                    </div>
                    <div class="modal-body">
                        <!-- 索引方式切换 -->
                        <div class="index-mode-tabs">
                            <button v-for="m in indexModes" :key="m.id" class="mode-tab"
                                :class="{ 'mode-tab--active': indexMode === m.id }" @click="indexMode = m.id">{{ m.label
                                }}</button>
                        </div>

                        <div class="form-grid" style="margin-top: var(--spacing-md)">
                            <!-- 上传文件 模式 -->
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
                                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
                                                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                                stroke-linecap="round" stroke-linejoin="round">
                                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                                <polyline points="14 2 14 8 20 8" />
                                            </svg>
                                            <span>{{ indexUploadFile.name }}</span>
                                            <button class="btn-link" style="margin-left:auto"
                                                @click.stop="indexUploadFile = null">移除</button>
                                        </template>
                                        <template v-else>
                                            <span>拖拽或点击选择文件</span>
                                        </template>
                                    </div>
                                </div>
                            </template>

                            <!-- 选择已上传文件 模式 -->
                            <template v-if="indexMode === 'select'">
                                <div class="field field--full">
                                    <label>选择文件 <em>*</em></label>
                                    <CustomSelect v-model="indexForm.file_id" :options="uploadedFileSelectOptions"
                                        placeholder="-- 请选择已上传文件 --" @change="loadUploadedFilesIfEmpty" />
                                </div>
                            </template>

                            <!-- 直接输入文本 模式 -->
                            <template v-if="indexMode === 'text'">
                                <div class="field field--full">
                                    <label>文档ID <em>*</em></label>
                                    <input v-model="indexForm.document_id" placeholder="如: my_doc_001" />
                                </div>
                                <div class="field field--full">
                                    <label>文档内容 <em>*</em></label>
                                    <textarea v-model="indexForm.text" rows="6" placeholder="输入要索引的文档内容..."></textarea>
                                </div>
                                <div class="field field--full">
                                    <label>来源</label>
                                    <input v-model="indexForm.metadata.source" placeholder="如：技术文档、应急预案" />
                                </div>
                            </template>

                            <!-- 通用字段 -->
                            <div class="field">
                                <label>集合名称</label>
                                <div class="input-with-btn">
                                    <input v-model="indexForm.collection_name" placeholder="documents" />
                                    <button class="btn-link" @click="autoSetCollectionName"
                                        title="根据文档类型自动设置">自动</button>
                                </div>
                            </div>

                            <div v-if="indexMode !== 'text'" class="field">
                                <label>文档ID</label>
                                <input v-model="indexForm.document_id"
                                    :placeholder="indexMode === 'upload' ? '留空使用文件名' : '留空使用文件ID'" />
                            </div>

                            <div class="field">
                                <label>文档类型</label>
                                <CustomSelect v-model="indexForm.metadata.document_type" :options="documentTypeOptions"
                                    @change="autoSetCollectionName" />
                            </div>

                            <div class="field">
                                <label>分块大小（字符）</label>
                                <input v-model.number="indexForm.chunk_size" type="number" min="100" max="2000"
                                    step="100" />
                                <small>建议 300–800</small>
                            </div>

                            <div class="field">
                                <label>分块重叠</label>
                                <input v-model.number="indexForm.overlap" type="number" min="0" max="500" step="10" />
                                <small>建议为分块大小的 10%</small>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn-secondary" @click="showIndexDialog = false">取消</button>
                        <button class="btn-primary" :disabled="indexing" @click="handleIndexDocument">
                            {{ indexing ? '索引中...' : '开始索引' }}
                        </button>
                    </div>
                </div>
            </div>
        </Teleport>

        <!-- 新增向量化器对话框 -->
        <Teleport to="body">
            <div v-if="showAddVectorizerDialog" class="modal-overlay" @click.self="showAddVectorizerDialog = false">
                <div class="modal-shell modal-shell--narrow">
                    <div class="modal-header">
                        <h3>新增向量化器</h3>
                        <button class="modal-close" @click="showAddVectorizerDialog = false">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="form-grid">
                            <div class="field field--full">
                                <label>Provider <em>*</em></label>
                                <CustomSelect v-model="addVectorizerForm.provider_key"
                                    :options="availableProviderSelectOptions" placeholder="-- 选择 Provider --"
                                    @change="onAddFormProviderChange" />
                            </div>
                            <div class="field field--full">
                                <label>模型名称 <em>*</em></label>
                                <input v-model="addVectorizerForm.model_name" list="add-model-list"
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
                    </div>
                    <div class="modal-footer">
                        <button class="btn-secondary" @click="showAddVectorizerDialog = false">取消</button>
                        <button class="btn-primary"
                            :disabled="addingVectorizer || !addVectorizerForm.provider_key || !addVectorizerForm.model_name"
                            @click="handleAddVectorizer">
                            {{ addingVectorizer ? '添加中...' : '确定' }}
                        </button>
                    </div>
                </div>
            </div>
        </Teleport>

        <!-- 迁移对话框 -->
        <Teleport to="body">
            <div v-if="showMigrateDialog" class="modal-overlay" @click.self="showMigrateDialog = false">
                <div class="modal-shell modal-shell--narrow">
                    <div class="modal-header">
                        <h3>迁移向量数据</h3>
                        <button class="modal-close" @click="showMigrateDialog = false">&times;</button>
                    </div>
                    <div class="modal-body">
                        <p class="migrate-desc">将「{{ migrateFromKey }}」中的向量数据迁移到另一个向量化器。</p>
                        <div class="form-grid">
                            <div class="field field--full">
                                <label>迁移目标向量化器 <em>*</em></label>
                                <CustomSelect v-model="migrateToKey" :options="migrateTargetOptions"
                                    placeholder="-- 选择目标 --" />
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn-secondary" @click="showMigrateDialog = false">取消</button>
                        <button class="btn-primary" :disabled="migrating || !migrateToKey" @click="handleMigrate">
                            {{ migrating ? '迁移中...' : '开始迁移' }}
                        </button>
                    </div>
                </div>
            </div>
        </Teleport>

        <AppToast ref="toastRef" />
    </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import AppToast from '../components/AppToast.vue';
import { getProviders } from '../api/modelAdapter';
import {
    activateVectorizer,
    addVectorizer,
    deleteFile,
    deleteFileIndex,
    deleteVectorizer,
    getFileStatus,
    indexFile,
    ingestFileToCollection,
    listFiles,
    listVectorizers,
    migrateVectorizer,
    searchVectors,
    uploadFiles,
} from '../api/vectorLibrary';
import CustomSelect from '../components/CustomSelect.vue';

const emit = defineEmits(['navigate']);

// ── Toast ─────────────────────────────────────────────────
const toastRef = ref(null);
function showToast(msg, type = 'error') { toastRef.value?.show(msg, type); }

// ── Tab ───────────────────────────────────────────────────
const activeTab = ref('store');
const globalLoading = ref(false);

const tabs = computed(() => [
    {
        id: 'store', label: '向量库管理',
        badge: fileList.value.length || null,
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`,
    },
    {
        id: 'files', label: '文件管理',
        badge: uploadedFiles.value.length || null,
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    },
    {
        id: 'vectorizers', label: '向量化器',
        badge: vectorizers.value.length || null,
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
    },
    {
        id: 'search', label: '搜索测试',
        icon: `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    },
]);

// ── 统计 ──────────────────────────────────────────────────
const summary = computed(() => ({
    totalFiles: uploadedFiles.value.length,
    indexedFiles: fileList.value.length,
    vectorizers: vectorizers.value.length,
}));

const activeVectorizerDisplay = computed(() => {
    const active = vectorizers.value.find(v => v.is_active);
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
    window.open(`/api/files/${encodeURIComponent(file.id)}/download`, '_blank');
}
async function handleDeleteUploadedFile(file) {
    if (!window.confirm(`确定删除文件"${file.original_name || file.filename}"？`)) return;
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

// ── 向量库矩阵 ────────────────────────────────────────────
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
const filteredFileList = computed(() => {
    if (!filterCollection.value) return fileList.value;
    return fileList.value.filter(f => f.collection === filterCollection.value);
});

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
            showToast(`索引成功，共 ${res.data?.indexed_count ?? 0} 个分块`, 'success');
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

async function handleDeleteIndexedFile(row) {
    if (!window.confirm(`确定删除"${row.file_name}"在所有向量化器下的分块与向量？此操作不可恢复。`)) return;
    deletingFileId.value = row.file_id;
    try {
        const res = await deleteFileIndex({ collection: row.collection, file_id: row.file_id });
        if (res.success) {
            showToast(`已删除，共 ${res.data?.deleted_chunks ?? 0} 个分块`, 'success');
            await refreshFileStatus();
        } else {
            showToast(res.message || '删除失败');
        }
    } catch (e) {
        showToast(e.message || '删除失败');
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
        const chunks = data?.chunk_count ?? data?.indexed_count ?? '?';
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
    if (!window.confirm(`确定删除向量化器"${key}"？将同时删除其向量数据。`)) return;
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
const addFormRecommendedModel = ref('');
const addFormModelList = ref([]);
const availableProviderSelectOptions = computed(() =>
    availableProviders.value.map(p => ({ value: p.key, label: `${p.name} (${p.provider_type})` }))
);

async function openAddVectorizerDialog() {
    showAddVectorizerDialog.value = true;
    if (availableProviders.value.length === 0) await loadProviders();
}

async function loadProviders() {
    try {
        const providers = await getProviders();
        availableProviders.value = providers.filter(p => {
            const emb = p.model_map?.embedding;
            return (emb != null && (Array.isArray(emb) ? emb.length > 0 : String(emb).trim())) || p.models?.length > 0;
        });
    } catch (e) {
        showToast('加载 Provider 列表失败');
    }
}

function onAddFormProviderChange(key) {
    const p = availableProviders.value.find(x => x.key === key);
    if (!p) { addFormRecommendedModel.value = ''; addFormModelList.value = []; return; }
    const emb = p.model_map?.embedding;
    addFormRecommendedModel.value = Array.isArray(emb) ? (emb[0] || '') : (emb || '');
    const all = new Set(p.models || []);
    if (p.model_map) {
        Object.values(p.model_map).forEach(m => {
            if (Array.isArray(m)) m.forEach(x => { if (x) all.add(String(x).trim()); });
            else if (m) all.add(String(m).trim());
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

// ── 搜索测试 ──────────────────────────────────────────────
const searchQuery = ref('');
const searchTopK = ref(5);
const searchCollection = ref('');
const searchLoading = ref(false);
const searchResults = ref([]);
const searchPerformed = ref(false);

function openSearchTest(collection) {
    searchCollection.value = collection;
    searchResults.value = [];
    searchPerformed.value = false;
    searchQuery.value = '';
}

async function handleSearch() {
    if (!searchQuery.value.trim()) { showToast('请输入搜索关键词'); return; }
    searchLoading.value = true;
    searchPerformed.value = true;
    try {
        const res = await searchVectors({
            query: searchQuery.value,
            top_k: searchTopK.value,
            collection: searchCollection.value || undefined,
        });
        searchResults.value = res.data?.results || res.results || [];
        if (searchResults.value.length === 0) showToast('未找到相关结果', 'warning');
    } catch (e) {
        showToast(e.message || '搜索失败');
    } finally {
        searchLoading.value = false;
    }
}

function scoreClass(score) {
    if (score > 0.8) return 'score-high';
    if (score > 0.6) return 'score-mid';
    if (score > 0.4) return 'score-low';
    return 'score-poor';
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
    await Promise.all([loadUploadedFiles(), refreshFileStatus(), refreshVectorizers()]);
    globalLoading.value = false;
}

onMounted(() => refreshAll());
</script>

<style scoped>
/* ─── 页面容器 ──────────────────────────────────────────── */
.vl-page {
    height: 100%;
    overflow: auto;
    padding: var(--spacing-xl);
    background: var(--color-bg-app);
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
}

.vl-shell {
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
}

/* ─── Header ────────────────────────────────────────────── */
.vl-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing-lg);
    padding: var(--spacing-md) var(--spacing-lg);
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-glass-border);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    box-shadow: var(--glass-shadow);
}

.header-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.page-title {
    font-size: var(--font-size-xl);
    font-weight: 700;
    margin: 0;
    color: var(--color-text-primary);
}

.page-subtitle {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    margin: 0;
}

.header-actions {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
}

/* ─── 统计卡片 ──────────────────────────────────────────── */
.summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--spacing-md);
}

.summary-card {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    border-radius: var(--radius-lg);
    padding: var(--spacing-md) var(--spacing-lg);
    border: 1px solid var(--color-glass-border);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    transition: border-color var(--transition-fast);
}

.summary-card:hover {
    border-color: rgba(var(--color-brand-accent-rgb), 0.35);
}

.summary-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    flex-shrink: 0;
}

.summary-icon--files {
    background: rgba(var(--color-brand-accent-rgb), 0.1);
    color: var(--color-brand-accent-light);
    border-color: rgba(var(--color-brand-accent-rgb), 0.2);
}

.summary-icon--indexed {
    background: rgba(var(--color-success-rgb), 0.1);
    color: var(--color-success);
    border-color: rgba(var(--color-success-rgb), 0.2);
}

.summary-icon--vectorizers {
    background: rgba(var(--color-warning-rgb), 0.1);
    color: var(--color-warning);
    border-color: rgba(var(--color-warning-rgb), 0.2);
}

.summary-icon--active {
    background: rgba(var(--color-active-rgb, var(--color-success-rgb)), 0.1);
    color: var(--color-active, var(--color-success));
    border-color: rgba(var(--color-active-rgb, var(--color-success-rgb)), 0.2);
}

.summary-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.summary-label {
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
    white-space: nowrap;
}

.summary-value {
    display: block;
    font-size: var(--font-size-2xl);
    font-weight: 700;
    line-height: 1.2;
    color: var(--color-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.summary-value--indexed {
    color: var(--color-success);
}

.summary-value--vectorizers {
    color: var(--color-warning);
}

.summary-value--active {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--color-success);
}

/* ─── Tab 导航 ──────────────────────────────────────────── */
.tab-nav {
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-glass-border);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    box-shadow: var(--glass-shadow);
    width: fit-content;
}

.tab-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: 8px 18px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
}

.tab-btn:hover {
    color: var(--color-text-primary);
    background: var(--color-hover-overlay);
}

.tab-btn--active {
    background: var(--color-bg-tertiary);
    color: var(--color-text-primary);
    font-weight: 500;
    box-shadow: var(--shadow-sm);
}

.tab-icon {
    display: flex;
    align-items: center;
}

.tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--color-bg-secondary);
    color: var(--color-text-secondary);
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
}

.tab-btn--active .tab-badge {
    background: rgba(var(--color-brand-accent-rgb), 0.2);
    color: var(--color-brand-accent-light);
}

/* ─── Tab 内容 ──────────────────────────────────────────── */
.tab-content {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
}

.tab-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
}

/* ─── 激活提示栏 ────────────────────────────────────────── */
.active-bar {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: 10px 16px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--color-glass-border);
    background: var(--glass-bg);
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

/* ─── Toolbar ───────────────────────────────────────────── */
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

.section-title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    margin: 0;
    color: var(--color-text-primary);
}

.section-desc {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
    margin: 0;
}

/* ─── 集合筛选下拉 ──────────────────────────────────────── */
.filter-select-wrap {
    width: 160px;
}

/* ─── 警告横幅 ──────────────────────────────────────────── */
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

/* ─── 按钮系统 ──────────────────────────────────────────── */
.btn-back,
.btn-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-xs);
    height: 40px;
    padding: 0 16px;
    border-radius: 20px;
    border: 1px solid var(--color-border);
    background: var(--color-interactive);
    color: var(--color-text-primary);
    font: inherit;
    font-size: var(--font-size-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
    cursor: pointer;
    white-space: nowrap;
    transition: all var(--transition-fast);
    user-select: none;
}

.btn-back:hover:not(:disabled),
.btn-action:hover:not(:disabled) {
    background: var(--color-interactive-hover);
    border-color: var(--color-border-hover);
}

.btn-action:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

/* 纯图标按钮：正方形，无文字 */
.btn-icon {
    width: 40px;
    padding: 0;
    justify-content: center;
}

/* 刷新中旋转动画 */
.spin {
    animation: spin 0.7s linear infinite;
}

.btn-primary {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    height: 40px;
    padding: 0 20px;
    border-radius: 20px;
    border: none;
    background: linear-gradient(135deg, rgba(var(--color-brand-accent-rgb), 0.9), rgba(var(--color-brand-accent-light-rgb), 0.95));
    color: #fff;
    font: inherit;
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
}

.btn-primary:hover:not(:disabled) {
    /* transform: translateY(-1px); */
    box-shadow: 0 4px 14px rgba(var(--color-brand-accent-rgb), 0.35);
}

.btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.btn-secondary {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    height: 40px;
    padding: 0 16px;
    border-radius: 20px;
    border: 1px solid var(--color-border);
    background: var(--color-interactive);
    color: var(--color-text-primary);
    font: inherit;
    font-size: var(--font-size-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
}

.btn-secondary:hover {
    background: var(--color-interactive-hover);
}

.btn-link {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--color-brand-accent-light);
    font: inherit;
    font-size: var(--font-size-sm);
    text-decoration: underline;
    transition: opacity var(--transition-fast);
}

.btn-link:hover {
    opacity: 0.8;
}

.btn-link:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    text-decoration: none;
}

/* ─── 行操作按钮 ────────────────────────────────────────── */
.row-actions {
    display: flex;
    gap: var(--spacing-xs);
}

.act-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-interactive);
    color: var(--color-text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
}

.act-btn:hover:not(:disabled) {
    color: var(--color-text-primary);
    background: var(--color-interactive-hover);
}

.act-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.act-btn--danger {
    color: var(--color-error);
    border-color: rgba(var(--color-error-rgb), 0.3);
    background: rgba(var(--color-error-rgb), 0.08);
}

.act-btn--danger:hover:not(:disabled) {
    border-color: rgba(var(--color-error-rgb), 0.5);
    background: rgba(var(--color-error-rgb), 0.14);
}

/* ─── 矩阵表格 ──────────────────────────────────────────── */
.data-table-wrapper {
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-glass-border);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
    -webkit-backdrop-filter: blur(var(--glass-blur));
    overflow: hidden;
}

.table-scroll {
    overflow-x: auto;
}

.data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
}

.data-table th,
.data-table td {
    padding: var(--spacing-sm) var(--spacing-md);
    text-align: left;
    border-bottom: 1px solid var(--color-border);
}

.data-table th {
    color: var(--color-text-secondary);
    font-weight: 500;
    font-size: var(--font-size-xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: var(--color-bg-secondary);
    position: sticky;
    top: 0;
    z-index: 1;
}

.data-table tr:last-child td {
    border-bottom: none;
}

.data-table tbody tr:hover {
    background: var(--color-hover-overlay);
}

.data-table .row-active {
    background: rgba(var(--color-success-rgb), 0.05);
}

.col-filename {
    min-width: 200px;
}

.col-collection {
    min-width: 100px;
}

.col-chunks {
    width: 80px;
}

.col-vectorizer {
    min-width: 160px;
}

.col-actions {
    width: 90px;
}

.text-center {
    text-align: center !important;
}

.font-mono {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
}

.cell-filename {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    color: var(--color-text-primary);
}

.cell-filename svg {
    color: var(--color-text-muted);
    flex-shrink: 0;
}

/* 向量化器列表头 */
.vectorizer-col-header {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
}

.vc-model {
    font-size: var(--font-size-xs);
    font-weight: 500;
    color: var(--color-text-primary);
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.vc-tag {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: var(--radius-full);
    font-size: 10px;
    font-weight: 500;
}

.vc-tag--provider {
    background: rgba(var(--color-brand-accent-rgb), 0.12);
    color: var(--color-brand-accent-light);
}

.vc-tag--dim {
    background: rgba(var(--color-warning-rgb), 0.12);
    color: var(--color-warning);
}

/* 集合标签 */
.collection-tag {
    display: inline-block;
    padding: 2px 8px;
    border-radius: var(--radius-full);
    background: var(--color-bg-tertiary);
    color: var(--color-text-secondary);
    font-size: var(--font-size-xs);
}

/* 状态标签 */
.status-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 8px;
    border-radius: var(--radius-full);
    font-size: var(--font-size-xs);
    font-weight: 500;
}

.status-badge--success {
    background: rgba(var(--color-success-rgb), 0.15);
    color: var(--color-success);
    border: 1px solid rgba(var(--color-success-rgb), 0.25);
}

/* 矩阵单元格内的索引按钮 */
.btn-index-cell {
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    border: 1px solid rgba(var(--color-brand-accent-rgb), 0.3);
    background: rgba(var(--color-brand-accent-rgb), 0.08);
    color: var(--color-brand-accent-light);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
}

.btn-index-cell:hover:not(:disabled) {
    background: rgba(var(--color-brand-accent-rgb), 0.15);
    border-color: rgba(var(--color-brand-accent-rgb), 0.45);
}

.btn-index-cell:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* ─── 内嵌检索测试 ──────────────────────────────────────── */
.search-inline-card {
    padding: var(--spacing-md);
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-glass-border);
    background: var(--glass-bg);
    backdrop-filter: blur(var(--glass-blur));
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

/* ─── 上传区 ────────────────────────────────────────────── */
.upload-zone {
    border-radius: var(--radius-xl);
    border: 2px dashed var(--color-border);
    background: var(--color-bg-secondary);
    padding: var(--spacing-xl);
    cursor: pointer;
    transition: all var(--transition-fast);
    text-align: center;
}

.upload-zone:hover {
    border-color: var(--color-border-hover);
    background: var(--color-bg-tertiary);
}

.upload-zone--dragover {
    border-color: var(--color-brand-accent);
    background: rgba(var(--color-brand-accent-rgb), 0.05);
}

.upload-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-md);
}

.upload-icon {
    color: var(--color-text-muted);
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

/* ─── 搜索框 ────────────────────────────────────────────── */
.search-form-card {
    padding: var(--spacing-lg);
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
    transition: all var(--transition-fast);
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
    gap: var(--spacing-lg);
}

.search-option {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
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

/* ─── 搜索结果 ──────────────────────────────────────────── */
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

.result-score {
    font-size: var(--font-size-sm);
    font-weight: 600;
    padding: 2px 8px;
    border-radius: var(--radius-full);
}

.score-high {
    background: rgba(var(--color-success-rgb), 0.15);
    color: var(--color-success);
}

.score-mid {
    background: rgba(var(--color-brand-accent-rgb), 0.15);
    color: var(--color-brand-accent-light);
}

.score-low {
    background: rgba(var(--color-warning-rgb), 0.15);
    color: var(--color-warning);
}

.score-poor {
    background: var(--color-bg-tertiary);
    color: var(--color-text-muted);
}

.result-source {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    margin-left: auto;
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

/* ─── 加载 & 空状态 ─────────────────────────────────────── */
.loading-state,
.empty-state {
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

.spinner {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-brand-accent-light);
    animation: spin 0.7s linear infinite;
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

.empty-state svg {
    opacity: 0.35;
}

/* ─── 模态框 ────────────────────────────────────────────── */
.modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--z-modal);
    padding: var(--spacing-md);
}

.modal-shell {
    background: var(--color-bg-secondary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--color-glass-border);
    box-shadow: var(--shadow-xl);
    max-height: 90vh;
    overflow-y: auto;
    width: min(680px, 100%);
}

.modal-shell--narrow {
    width: min(440px, 100%);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-lg);
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;
}

.modal-header h3 {
    font-size: var(--font-size-lg);
    font-weight: 600;
    margin: 0;
    color: var(--color-text-primary);
}

.modal-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    transition: all var(--transition-fast);
}

.modal-close:hover {
    color: var(--color-text-primary);
    background: var(--color-hover-overlay);
}

.modal-body {
    padding: var(--spacing-lg);
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-sm);
    padding: var(--spacing-md) var(--spacing-lg);
    border-top: 1px solid var(--color-border);
}

/* ─── 索引模式选项卡 ────────────────────────────────────── */
.index-mode-tabs {
    display: flex;
    gap: 2px;
    padding: 3px;
    background: var(--color-bg-tertiary);
    border-radius: var(--radius-lg);
    width: fit-content;
}

.mode-tab {
    padding: 7px 14px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--color-text-secondary);
    font: inherit;
    font-size: var(--font-size-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
}

.mode-tab:hover {
    color: var(--color-text-primary);
}

.mode-tab--active {
    background: var(--color-bg-secondary);
    color: var(--color-text-primary);
    font-weight: 500;
    box-shadow: var(--shadow-sm);
}

/* ─── 迷你上传区 ────────────────────────────────────────── */
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
    transition: all var(--transition-fast);
}

.mini-upload-zone:hover {
    border-color: var(--color-brand-accent);
    color: var(--color-text-primary);
}

.mini-upload-zone--has {
    border-style: solid;
    border-color: var(--color-success);
    color: var(--color-text-primary);
}

/* ─── 表单 ──────────────────────────────────────────────── */
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

.field input,
.field textarea {
    width: 100%;
    height: 40px;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-border);
    background: var(--color-bg-secondary);
    color: var(--color-text-primary);
    padding: 0 12px;
    font: inherit;
    font-size: var(--font-size-sm);
    transition: border-color var(--transition-fast);
}

.field textarea {
    resize: vertical;
    min-height: 80px;
    height: auto;
    padding: 10px 12px;
}

.field input:focus,
.field textarea:focus {
    outline: none;
    border-color: var(--color-border-focus);
    box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.16);
}

.field input:hover,
.field textarea:hover {
    border-color: var(--color-border-hover);
}

.field input::placeholder,
.field textarea::placeholder {
    color: var(--color-text-muted);
}

.input-with-btn {
    display: flex;
    gap: var(--spacing-xs);
}

.input-with-btn input {
    flex: 1;
}

/* ─── 迁移描述 ──────────────────────────────────────────── */
.migrate-desc {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    margin: 0 0 var(--spacing-md) 0;
    padding: 10px 14px;
    border-radius: var(--radius-md);
    background: var(--color-bg-tertiary);
}

/* ─── 响应式 ────────────────────────────────────────────── */

/* ── 平板（≤900px）── */
@media (max-width: 900px) {
    .summary-grid {
        grid-template-columns: repeat(2, 1fr);
    }

    .vl-shell {
        max-width: 100%;
    }
}

/* ── 手机横屏 / 小平板（≤720px）── */
@media (max-width: 720px) {
    .vl-page {
        padding: var(--spacing-md);
        gap: var(--spacing-md);
    }

    /* Header：标题行压缩，按钮只显示图标 */
    .vl-header {
        flex-direction: row;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--spacing-sm);
        padding: var(--spacing-sm) var(--spacing-md);
    }

    .page-subtitle {
        display: none;
    }

    .page-title {
        font-size: var(--font-size-lg);
    }

    .header-actions {
        margin-left: auto;
    }

    /* Header 返回按钮：仅保留图标 */
    .btn-back .btn-text-label {
        display: none;
    }

    .btn-back {
        width: 36px;
        height: 36px;
        padding: 0;
        border-radius: 50%;
        justify-content: center;
    }

    /* 统计卡片：2列，缩小内边距和图标 */
    .summary-grid {
        grid-template-columns: 1fr 1fr;
        gap: var(--spacing-sm);
    }

    .summary-card {
        padding: var(--spacing-sm) var(--spacing-md);
        gap: var(--spacing-sm);
    }

    .summary-icon {
        width: 36px;
        height: 36px;
        flex-shrink: 0;
    }

    .summary-icon svg {
        width: 16px;
        height: 16px;
    }

    .summary-value {
        font-size: var(--font-size-xl);
    }

    /* Tab 导航：等宽平铺 */
    .tab-nav {
        width: 100%;
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 2px;
    }

    .tab-btn {
        padding: 8px 6px;
        font-size: 12px;
        justify-content: center;
        flex-direction: column;
        gap: 3px;
        white-space: nowrap;
    }

    .tab-badge {
        display: none;
    }

    /* Toolbar：上下两行 */
    .section-toolbar {
        flex-direction: column;
        align-items: stretch;
        gap: var(--spacing-sm);
    }

    .toolbar-right {
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: var(--spacing-xs);
    }

    /* 筛选下拉撑满剩余宽度 */
    .filter-select-wrap {
        flex: 1;
        min-width: 120px;
        width: auto;
    }

    /* 表格：减小单元格内边距 */
    .data-table th,
    .data-table td {
        padding: 8px 10px;
    }

    /* 表单：单列 */
    .form-grid {
        grid-template-columns: 1fr;
    }

    /* 内嵌搜索框：换行 */
    .search-inline-card .search-box {
        flex-wrap: wrap;
    }

    .search-inline-card .search-input {
        flex: 1 1 100%;
    }

    /* 全局搜索区：搜索框换行 */
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

    /* 上传区：缩小内边距 */
    .upload-zone {
        padding: var(--spacing-lg) var(--spacing-md);
    }

    .upload-icon {
        width: 36px;
        height: 36px;
    }

    /* 模态框：底部弹出风格 */
    .modal-overlay {
        align-items: flex-end;
        padding: 0;
    }

    .modal-shell {
        width: 100%;
        max-height: 88vh;
        border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    }

    .modal-shell--narrow {
        width: 100%;
    }
}

/* ── 手机竖屏（≤480px）── */
@media (max-width: 480px) {
    .vl-page {
        padding: var(--spacing-sm);
    }

    /* 统计卡片：超小屏保持2列但更紧凑 */
    .summary-grid {
        gap: var(--spacing-xs);
    }

    .summary-card {
        padding: var(--spacing-xs) var(--spacing-sm);
    }

    .summary-icon {
        display: none;
    }

    .summary-value {
        font-size: var(--font-size-lg);
    }

    /* Tab：图标隐藏，只留文字 */
    .tab-icon {
        display: none;
    }

    .tab-btn {
        flex-direction: row;
        font-size: 11px;
        padding: 7px 4px;
    }

    /* 按钮文字缩减 */
    .btn-primary,
    .btn-action,
    .btn-back {
        font-size: 12px;
    }

    /* 表格单元格更紧凑 */
    .data-table th,
    .data-table td {
        padding: 6px 8px;
        font-size: 12px;
    }

    .col-filename {
        min-width: 120px;
    }

    .col-vectorizer {
        min-width: 100px;
    }

    /* 索引模式选项卡：均等分布 */
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

    /* 搜索结果：缩小内边距 */
    .result-item {
        padding: var(--spacing-sm);
    }

    /* active-bar：换行 */
    .active-bar {
        flex-wrap: wrap;
        gap: var(--spacing-xs);
    }
}
</style>
