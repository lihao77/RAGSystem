<template>
    <PageLayout
        class="kb-manager-page"
        :embedded="embedded"
        :chat-return-path="chatReturnPath"
        mobile-content-padding="var(--spacing-sm)"
        title="知识库管理"
        subtitle="文件、向量索引与向量化器"
        mobile-title="知识库管理"
    >
        <template #header-actions>
            <Button variant="ghost" size="icon-sm" :disabled="globalLoading" aria-label="全局刷新" title="全局刷新" @click="refreshAll">
                <IconRefresh :size="16" />
            </Button>
        </template>
        <template #mobile-menu="{ close }">
            <button class="pl-menu-item" :disabled="globalLoading" @click="refreshAll(); close()">
                <IconRefresh :size="16" />
                全局刷新
            </button>
        </template>

            <!-- ── 统计卡片 ───────────────────────────────────── -->
            <KpiCards :items="kpiItems" />

            <!-- ── Tab 导航（全项目统一的胶囊分段控件）────────────── -->
            <SegmentedControl v-model="activeTab" :options="tabs" aria-label="知识库分区" />

            <!-- ── Tab 内容 ──────────────────────────────────── -->
            <section class="tab-content">

                <!-- ══ Tab 1: 知识库管理 ══════════════════════════ -->
                <KnowledgeBaseStorePanel :context="context" />
                <KnowledgeBaseVectorizersPanel :context="context" />
                <KnowledgeBaseRerankersPanel :context="context" />
                <KnowledgeBaseSearchPanel :context="context" />
            </section>
        <KnowledgeBaseDialogs :context="context" />
    </PageLayout>
</template>

<script setup>
import PageLayout from '../components/PageLayout.vue';
import IconRefresh from '../components/icons/IconRefresh.vue';
import KpiCards from '../components/admin/KpiCards.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import { Button } from '../components/ui/button';
import { useKnowledgeBaseManager } from '../composables/useKnowledgeBaseManager.js';
import KnowledgeBaseStorePanel from '../components/knowledge-base/KnowledgeBaseStorePanel.vue';
import KnowledgeBaseVectorizersPanel from '../components/knowledge-base/KnowledgeBaseVectorizersPanel.vue';
import KnowledgeBaseRerankersPanel from '../components/knowledge-base/KnowledgeBaseRerankersPanel.vue';
import KnowledgeBaseSearchPanel from '../components/knowledge-base/KnowledgeBaseSearchPanel.vue';
import KnowledgeBaseDialogs from '../components/knowledge-base/KnowledgeBaseDialogs.vue';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const { context } = useKnowledgeBaseManager();
const { globalLoading, refreshAll, kpiItems, tabs, activeTab } = context;
</script>

<style scoped>
/* ─── Tab 内容 ──────────────────────────────────────────── */
.tab-content {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
}

/* ─── 激活提示栏 ────────────────────────────────────────── */

/* ─── Toolbar ───────────────────────────────────────────── */

/* ─── 集合筛选下拉 ──────────────────────────────────────── */

/* ─── 警告横幅 ──────────────────────────────────────────── */

/* 刷新中旋转动画 — 复用全局节奏 */
.spin {
    animation: g-spin 0.8s linear infinite;
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
    transition: opacity 0.2s;
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

/* ─── 数据表格（shadcn Table 特化）────────────────────────── */

/* 表头视觉 / 单元格 padding：覆盖 shadcn 默认，更舒展更紧凑 */

/* 激活行：当前向量化器 / 重排序器 */
.row-active {
    background: rgba(var(--color-success-rgb), 0.07);
}

/* 列宽 */

/* 向量化器列表头（矩阵列）*/

/* 状态徽章不换行 */

/* ─── 内嵌检索测试 ──────────────────────────────────────── */

/* ─── 上传区 ────────────────────────────────────────────── */

.upload-zone--dragover {
    border-color: var(--color-brand-accent);
    background: rgba(var(--color-brand-accent-rgb), 0.05);
}

.upload-icon {
    color: var(--color-text-muted);
}

/* ─── 搜索框 ────────────────────────────────────────────── */

.search-toggle--disabled {
    cursor: not-allowed;
    opacity: 0.55;
}

/* ─── 搜索结果 ──────────────────────────────────────────── */

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

/* ─── 加载 & 空状态 ─────────────────────────────────────── */

/* ─── 表单 ──────────────────────────────────────────────── */

/* ─── 迁移描述 ──────────────────────────────────────────── */

/* ─── 响应式 ────────────────────────────────────────────── */

/* ── 手机横屏 / 小平板（≤720px）── */
@media (max-width: 720px) {
    .vl-tab-badge {
        display: none;
    }

    /* Toolbar：上下两行 */

    /* 筛选下拉撑满剩余宽度 */

    /* 表格：减小单元格内边距 */

    /* 表单：单列 */

    /* 内嵌搜索框：换行 */

    /* 全局搜索区：搜索框换行 */

    /* 上传区：缩小内边距 */

    .upload-icon {
        width: 36px;
        height: 36px;
    }
}

/* ── 手机竖屏（≤480px）── */
@media (max-width: 480px) {
    /* 按钮文字缩减 */

    /* 表格单元格更紧凑 */

    /* 索引模式选项卡：均等分布 */

    /* 搜索结果：缩小内边距 */

    /* active-bar：换行 */
}
</style>
