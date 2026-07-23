<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="file-changes-sheet flex w-full flex-col gap-0 p-0 sm:max-w-[1040px]">
      <SheetHeader class="file-changes-header">
        <div class="min-w-0">
          <SheetTitle>本轮文件变更</SheetTitle>
          <SheetDescription>当前选中 Agent 消息修改的文件与行级差异</SheetDescription>
        </div>
        <div class="file-changes-header__actions">
          <div v-if="displayFiles.length && !loading" class="file-changes-summary" aria-label="变更摘要">
            <span><Files aria-hidden="true" />{{ displayFiles.length }} 个文件</span>
            <span class="file-changes-summary__added">+{{ summaryStats.added }}</span>
            <span class="file-changes-summary__removed">-{{ summaryStats.removed }}</span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="loading || !sessionId"
            aria-label="刷新文件变更"
            title="刷新文件变更"
            @click="load"
          >
            <RefreshCw :class="{ 'file-changes-spin': loading }" aria-hidden="true" />
          </Button>
        </div>
      </SheetHeader>

      <div class="file-changes-layout">
        <aside class="file-changes-sidebar">
          <div class="file-changes-list">
            <template v-if="displayFiles.length">
              <Button
                v-for="file in displayFiles"
                :key="file.path"
                variant="ghost"
                class="file-changes-item"
                :active="selectedFile?.path === file.path"
                :aria-current="selectedFile?.path === file.path ? 'true' : undefined"
                @click="selectedPath = file.path"
              >
                <component
                  :is="file.action === 'created' ? FilePlus2 : FilePenLine"
                  class="file-changes-item__icon"
                  aria-hidden="true"
                />
                <span class="file-changes-item__main">
                  <span class="file-changes-item__path" :title="file.path">{{ file.fileName }}</span>
                </span>
                <span class="file-changes-item__meta">
                  <Badge :variant="file.action === 'created' ? 'success' : 'outline'">
                    {{ actionLabel(file.action) }}
                  </Badge>
                  <span v-if="file.added || file.removed" class="file-changes-item__stats" aria-label="行变更统计">
                    <span>+{{ file.added }}</span>
                    <span>-{{ file.removed }}</span>
                  </span>
                </span>
              </Button>
            </template>

            <EmptyState
              v-else-if="!loading && !error"
              compact
              :icon="FolderOpen"
              title="本轮没有文件变更"
            />
          </div>
        </aside>

        <main class="file-changes-main" :aria-busy="loading">
          <div v-if="loading" class="file-changes-state">
            <span class="g-spinner" aria-hidden="true"></span>
            <span>加载变更中...</span>
          </div>

          <EmptyState
            v-else-if="error"
            :icon="CircleAlert"
            tone="error"
            title="无法加载文件变更"
            :hint="error"
          >
            <Button variant="outline" size="sm" :disabled="!sessionId" @click="load">
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              重新加载
            </Button>
          </EmptyState>

          <div v-else-if="selectedFile" class="file-changes-diff" data-selectable="true">
            <div class="file-changes-diff__header">
              <div class="file-changes-diff__identity">
                <component
                  :is="selectedFile.action === 'created' ? FilePlus2 : FilePenLine"
                  aria-hidden="true"
                />
                <span :title="selectedFile.path">{{ selectedFile.displayPath }}</span>
              </div>
              <div class="file-changes-diff__stats" aria-label="当前文件行变更统计">
                <Badge :variant="selectedFile.action === 'created' ? 'success' : 'outline'">
                  {{ actionLabel(selectedFile.action) }}
                </Badge>
                <span class="file-changes-diff__added">+{{ selectedFile.added }}</span>
                <span class="file-changes-diff__removed">-{{ selectedFile.removed }}</span>
              </div>
            </div>

            <div v-if="selectedFile.diff.length" class="file-changes-code" role="table" aria-label="行级文件差异">
              <div class="file-changes-code__head" role="row">
                <span role="columnheader">旧</span>
                <span role="columnheader">新</span>
                <span role="columnheader" aria-label="变更标记"></span>
                <span role="columnheader">内容</span>
              </div>
              <div
                v-for="(line, index) in selectedFile.diff"
                :key="`${index}-${line.oldLine}-${line.newLine}`"
                :class="lineClass(line.type)"
                class="file-changes-line"
                role="row"
              >
                <span class="file-changes-line__number" role="cell">{{ line.oldLine ?? '' }}</span>
                <span class="file-changes-line__number" role="cell">{{ line.newLine ?? '' }}</span>
                <span class="file-changes-line__mark" role="cell" aria-hidden="true">{{ lineMark(line.type) }}</span>
                <span class="file-changes-line__content" role="cell">{{ line.content || ' ' }}</span>
              </div>
            </div>

            <EmptyState
              v-else
              compact
              :icon="Files"
              title="文件内容没有差异"
            />
          </div>

          <EmptyState
            v-else
            :icon="FolderOpen"
            title="暂无可查看的差异"
          />
        </main>
      </div>
    </SheetContent>
  </Sheet>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { CircleAlert, FilePenLine, FilePlus2, Files, FolderOpen, RefreshCw } from 'lucide-vue-next';
import { getLatestFileChanges } from '../../api/fileChanges.js';
import EmptyState from '../EmptyState.vue';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';

const props = defineProps({
  open: Boolean,
  sessionId: { type: String, default: '' },
  messageSeq: { type: Number, default: null },
});
const emit = defineEmits(['update:open']);
const files = ref([]);
const loading = ref(false);
const error = ref('');
const selectedPath = ref('');
let loadRequest = 0;

const displayFiles = computed(() => files.value.map(file => {
  const normalizedPath = String(file.path || '').replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  const fileName = segments.at(-1) || normalizedPath;
  const displayPath = segments.length > 2
    ? `.../${segments.slice(-2).join('/')}`
    : segments.join('/') || normalizedPath;
  const added = file.diff?.filter(line => line.type === 'added').length || 0;
  const removed = file.diff?.filter(line => line.type === 'removed').length || 0;
  return {
    ...file,
    fileName,
    displayPath,
    added,
    removed,
  };
}));

const selectedFile = computed(() => (
  displayFiles.value.find(file => file.path === selectedPath.value) || displayFiles.value[0] || null
));

const summaryStats = computed(() => displayFiles.value.reduce((summary, file) => ({
  added: summary.added + file.added,
  removed: summary.removed + file.removed,
}), { added: 0, removed: 0 }));

async function load() {
  if (!props.sessionId) return;
  const request = ++loadRequest;
  loading.value = true;
  error.value = '';
  try {
    const result = await getLatestFileChanges(props.sessionId, props.messageSeq);
    if (request !== loadRequest) return;
    files.value = Array.isArray(result.files) ? result.files : [];
    if (!files.value.some(file => file.path === selectedPath.value)) selectedPath.value = files.value[0]?.path || '';
  } catch (loadError) {
    if (request === loadRequest) error.value = loadError.message || '加载文件变更失败';
  } finally {
    if (request === loadRequest) loading.value = false;
  }
}

watch(() => [props.open, props.sessionId, props.messageSeq], ([open]) => {
  if (open) {
    void load();
  } else {
    loadRequest += 1;
  }
});

const actionLabel = action => action === 'created' ? '新增' : '修改';
const lineMark = type => type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
const lineClass = type => ({
  'file-changes-line--added': type === 'added',
  'file-changes-line--removed': type === 'removed',
});
</script>

<style scoped>
.file-changes-sheet {
  --file-changes-toolbar-height: 48px;
  --file-changes-toolbar-bg: color-mix(in srgb, var(--color-bg-secondary) 35%, var(--color-bg-primary));
  --file-changes-added-bg: color-mix(in srgb, var(--color-success) 8%, transparent);
  --file-changes-added-line-bg: color-mix(in srgb, var(--color-success) 6%, transparent);
  --file-changes-removed-bg: color-mix(in srgb, var(--color-error) 8%, transparent);
  --file-changes-removed-line-bg: color-mix(in srgb, var(--color-error) 6%, transparent);
  background: var(--color-bg-primary);
}

.file-changes-header {
  min-height: 72px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 16px 56px 16px 24px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-primary);
}

.file-changes-summary {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 6px;
  background: var(--color-bg-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.file-changes-header__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.file-changes-summary > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-family: var(--font-sans);
}

.file-changes-summary svg {
  width: 14px;
  height: 14px;
}

.file-changes-summary__added,
.file-changes-diff__added,
.file-changes-item__stats > span:first-child {
  color: var(--color-success);
}

.file-changes-summary__removed,
.file-changes-diff__removed,
.file-changes-item__stats > span:last-child {
  color: var(--color-error);
}

.file-changes-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

.file-changes-sidebar {
  display: flex;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-secondary) 15%, var(--color-bg-primary));
}

.file-changes-list {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 10px;
  scrollbar-gutter: stable;
}

.file-changes-item {
  min-width: 0;
  width: 100%;
  max-width: 100%;
  min-height: 60px;
  height: auto;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  overflow: hidden;
  text-align: left;
  white-space: normal;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.file-changes-item + .file-changes-item {
  margin-top: 4px;
}

.file-changes-item[data-active] {
  border-color: color-mix(in srgb, var(--color-brand-accent) 24%, transparent);
  background: color-mix(in srgb, var(--color-brand-accent) 10%, transparent);
}

.file-changes-item:hover:not([data-active]) {
  border-color: var(--color-border);
  background: color-mix(in srgb, var(--color-bg-secondary) 50%, transparent);
}

.file-changes-item__icon {
  width: 16px;
  height: 16px;
  color: var(--color-text-muted);
  transition: color var(--transition-fast);
}

.file-changes-item[data-active] .file-changes-item__icon {
  color: var(--color-brand-accent);
}

.file-changes-item:hover .file-changes-item__icon {
  color: var(--color-text-secondary);
}

.file-changes-item__main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.file-changes-item__path {
  display: block;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-changes-item__path {
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}

.file-changes-item__meta {
  display: flex;
  align-items: flex-end;
  flex-direction: column;
  flex-shrink: 0;
  gap: 4px;
}

.file-changes-item__stats {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
}

.file-changes-main {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: var(--color-bg-primary);
}

.file-changes-state {
  min-height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.file-changes-spin {
  animation: g-spin 0.8s linear infinite;
}

.file-changes-diff {
  min-width: 720px;
  min-height: 100%;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 22px;
}

.file-changes-diff__header {
  position: sticky;
  top: 0;
  left: 0;
  z-index: 2;
  height: var(--file-changes-toolbar-height);
  min-height: var(--file-changes-toolbar-height);
  box-sizing: border-box;
  min-width: 720px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--file-changes-toolbar-bg) 88%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  font-family: var(--font-sans);
}

.file-changes-diff__identity {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.file-changes-diff__identity svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.file-changes-diff__identity span {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-changes-diff__stats {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.file-changes-code {
  min-width: 720px;
  padding: 0;
}

.file-changes-code__head {
  height: 28px;
  display: grid;
  grid-template-columns: 56px 56px 28px minmax(max-content, 1fr);
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-secondary) 40%, var(--color-bg-primary));
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
  line-height: 28px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.file-changes-code__head > span {
  padding: 0 8px;
}

.file-changes-code__head > span:nth-child(-n + 2) {
  border-right: 1px solid var(--color-border);
  text-align: right;
}

.file-changes-code__head > span:last-child {
  padding-left: 12px;
}

.file-changes-line {
  display: grid;
  grid-template-columns: 56px 56px 28px minmax(max-content, 1fr);
  min-height: 22px;
  color: var(--color-text-primary);
  transition: background var(--transition-fast);
}

.file-changes-line:hover {
  background: color-mix(in srgb, var(--color-bg-secondary) 25%, transparent);
}

.file-changes-line__number {
  padding: 0 10px;
  border-right: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-secondary) 30%, transparent);
  color: var(--color-text-muted);
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

.file-changes-line__mark {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  user-select: none;
}

.file-changes-line__content {
  padding: 0 16px;
  white-space: pre;
  word-break: break-all;
}

.file-changes-line--added {
  background: var(--file-changes-added-line-bg);
}

.file-changes-line--removed {
  background: var(--file-changes-removed-line-bg);
}

.file-changes-line--added:hover {
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
}

.file-changes-line--removed:hover {
  background: color-mix(in srgb, var(--color-error) 12%, transparent);
}

.file-changes-line--added .file-changes-line__mark {
  color: var(--color-success);
  background: var(--file-changes-added-bg);
}

.file-changes-line--removed .file-changes-line__mark {
  color: var(--color-error);
  background: var(--file-changes-removed-bg);
}

.file-changes-line--added .file-changes-line__number {
  background: color-mix(in srgb, var(--color-success) 4%, var(--color-bg-secondary) 30%);
}

.file-changes-line--removed .file-changes-line__number {
  background: color-mix(in srgb, var(--color-error) 4%, var(--color-bg-secondary) 30%);
}

@media (max-width: 767px) {
  .file-changes-diff,
  .file-changes-diff__header,
  .file-changes-code {
    min-width: 620px;
  }

  .file-changes-header {
    min-height: 76px;
    align-items: flex-start;
    padding: 14px 48px 14px 16px;
  }

  .file-changes-summary {
    display: none;
  }

  .file-changes-layout {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(160px, 35vh) minmax(0, 1fr);
  }

  .file-changes-sidebar {
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .file-changes-item {
    min-height: 52px;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    padding: 8px 10px;
  }

  .file-changes-item__stats {
    display: none;
  }

  .file-changes-line {
    grid-template-columns: 48px 48px 24px minmax(max-content, 1fr);
  }

  .file-changes-code__head {
    grid-template-columns: 48px 48px 24px minmax(max-content, 1fr);
    height: 26px;
    line-height: 26px;
  }

  .file-changes-line__number {
    padding: 0 8px;
    font-size: 11px;
  }
}
</style>
