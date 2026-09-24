<template>
  <div class="session-setup-panel" aria-label="新会话上下文">
    <Popover v-model:open="projectPickerOpen">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="project-trigger"
          :class="{ 'is-open': projectPickerOpen }"
          :disabled="workspaceLoading"
          :title="currentWorkspace?.root_path || projectLabel"
          role="combobox"
          :aria-expanded="projectPickerOpen"
          aria-label="选择项目"
        >
          <FolderOpen class="project-trigger-icon" aria-hidden="true" />
          <span class="project-trigger-label">{{ projectLabel }}</span>
          <ChevronDown class="project-trigger-arrow" :class="{ 'is-open': projectPickerOpen }" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        class="project-picker-popover p-0 rounded-xl shadow-[var(--shadow-lg)]"
        align="start"
        side="bottom"
        :side-offset="6"
        aria-label="选择项目"
        @open-auto-focus="focusSearch"
      >
        <label class="project-picker-search">
          <Search class="project-picker-search-icon" aria-hidden="true" />
          <input
            ref="searchInputRef"
            v-model="filterQuery"
            type="text"
            class="project-picker-search-input"
            placeholder="搜索项目"
            aria-label="搜索项目"
          />
        </label>
        <ul class="project-list" role="listbox" aria-label="项目列表">
          <li v-for="workspace in filteredWorkspaces" :key="workspace.workspace_id">
            <button
              type="button"
              role="option"
              class="project-option"
              :class="{ 'is-selected': workspace.workspace_id === currentWorkspaceId }"
              :aria-selected="workspace.workspace_id === currentWorkspaceId"
              :title="workspace.root_path || workspace.display_name"
              @click="selectWorkspace(workspace.workspace_id)"
            >
              <FolderKanban class="project-option-icon" aria-hidden="true" />
              <span class="project-option-name">{{ workspace.display_name }}</span>
              <Check
                v-if="workspace.workspace_id === currentWorkspaceId"
                class="project-option-check"
                aria-hidden="true"
              />
            </button>
          </li>
        </ul>
        <p v-if="!filteredWorkspaces.length" class="project-list-empty">
          {{ workspaces.length ? '没有匹配的项目' : '暂无项目，可从侧栏添加本地文件夹' }}
        </p>
        <div class="project-picker-actions">
          <button
            type="button"
            role="option"
            class="project-option"
            :class="{ 'is-selected': isUnassigned }"
            :aria-selected="isUnassigned"
            title="新会话不绑定项目"
            @click="selectWorkspace(UNASSIGNED_WORKSPACE_ID)"
          >
            <FolderX class="project-option-icon" aria-hidden="true" />
            <span class="project-option-name">不指定项目</span>
            <Check v-if="isUnassigned" class="project-option-check" aria-hidden="true" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { Check, ChevronDown, FolderKanban, FolderOpen, FolderX, Search } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { UNASSIGNED_WORKSPACE_ID, useWorkspaceStore } from '../../stores/workspace.js';

const props = defineProps({
  workspaceRoot: { type: String, default: '' },
});

const emit = defineEmits(['update:workspaceRoot']);
const workspaceStore = useWorkspaceStore();
const {
  items: workspaces,
  currentWorkspaceId,
  currentWorkspace,
  loading: workspaceLoading,
} = storeToRefs(workspaceStore);
const projectPickerOpen = ref(false);
const filterQuery = ref('');
const searchInputRef = ref(null);

const isUnassigned = computed(() => currentWorkspaceId.value === UNASSIGNED_WORKSPACE_ID);

const projectLabel = computed(() => {
  if (workspaceLoading.value) return '加载项目…';
  if (currentWorkspace.value) return currentWorkspace.value.display_name;
  if (isUnassigned.value) return '未指定项目';
  return '选择项目';
});

const filteredWorkspaces = computed(() => {
  const query = filterQuery.value.trim().toLowerCase();
  if (!query) return workspaces.value;
  return workspaces.value.filter((workspace) => `${workspace.display_name || ''} ${workspace.root_path || ''}`
    .toLowerCase()
    .includes(query));
});

function selectWorkspace(id) {
  const workspace = workspaceStore.select(id);
  emit('update:workspaceRoot', workspace?.root_path || '');
  projectPickerOpen.value = false;
}

// 打开即把光标交给搜索框：不 preventDefault，先让 reka 把焦点落到弹层内容上，
// 再接管到搜索框。若拦截默认聚焦、而输入框此刻尚未挂载，焦点会留在弹层外，
// 被判定为 focus-outside 把刚打开的面板关掉（表现为随机打不开）。
function focusSearch() {
  nextTick(() => searchInputRef.value?.focus());
}

watch(projectPickerOpen, (open) => {
  if (!open) filterQuery.value = '';
});

watch(currentWorkspace, (workspace) => {
  const rootPath = workspace?.root_path || '';
  if (rootPath !== props.workspaceRoot) emit('update:workspaceRoot', rootPath);
}, { immediate: true });
</script>

<style scoped>
.session-setup-panel {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0;
}

/* 胶囊触发器：平时与顶行同底色（不描边、不铺色），hover / 展开时才浮起 */
.project-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  max-width: min(100%, 360px);
  /* 8px = 外壳顶行的内边距，胶囊文字因此与输入框正文落在同一条 16px 竖线上 */
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 18px;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.project-trigger:hover,
.project-trigger.is-open {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

/* 聚焦指示沿用 hover 底色：避免点选项目后焦点回到触发器时的光圈闪现 */
.project-trigger:focus-visible {
  outline: none;
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.project-trigger:disabled {
  cursor: default;
  opacity: 0.6;
}

.project-trigger-icon,
.project-trigger-arrow {
  width: 14px;
  height: 14px;
  flex: none;
}

.project-trigger-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 行高必须高于字号：中文字形超出 1em，overflow:hidden 下会被上下切掉 */
  line-height: 18px;
  font-weight: 500;
  /* 字体升降部不对称，行盒居中时字形整体偏下，往上做 1px 视觉补偿 */
  transform: translateY(-1px);
}

.project-trigger-arrow {
  color: var(--color-text-muted);
  transition: transform var(--transition-fast);
}

.project-trigger-arrow.is-open {
  transform: rotate(180deg);
}

/* shadcn PopoverContent 自带 z-50/w-72/rounded-md/border/bg-popover/p-4/shadow-md/popover 文字色。
   本项目 tailwind.config 已把 popover 主题映射到我们的 token（popover→--color-bg-elevated、
   popover-foreground→--color-text-primary，w-72 即 288px），这些默认值就是设计值，保持不动；
   只有三处默认与设计不符，故在 class 上就地覆盖：p-4→p-0、rounded-md→rounded-xl(12px)、
   shadow-md→--shadow-lg。注意它们都在工具类层，优先级高于本文件的 scoped 规则——所以
   面板尺寸/底色/字色别再写进 scoped（会被默认值盖掉，成为死代码）。 */
.project-picker-popover {
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 24px);
  max-height: min(420px, 60vh);
  border-color: var(--color-border);
  overflow: hidden;
}

.project-picker-search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  flex: none;
  padding: 0 14px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted);
  cursor: text;
}

.project-picker-search-icon {
  width: 14px;
  height: 14px;
  flex: none;
}

.project-picker-search-input {
  min-width: 0;
  flex: 1 1 auto;
  height: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  outline: none;
}

.project-picker-search-input::placeholder {
  color: var(--color-text-muted);
}

.project-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  list-style: none;
}

/* 选中态只留对勾，不铺底色（与参考的列表观感一致） */
.project-option {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
}

.project-option:hover,
.project-option:focus-visible {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
  outline: none;
}

.project-option.is-selected {
  color: var(--color-text-primary);
}

.project-option-icon,
.project-option-check {
  width: 16px;
  height: 16px;
  flex: none;
}

.project-option-icon {
  color: var(--color-text-muted);
}

.project-option-check {
  width: 14px;
  height: 14px;
  justify-self: end;
  color: var(--color-brand-accent-light);
}

.project-option-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  font-size: var(--font-size-sm);
  font-weight: 500;
  line-height: 18px;
  letter-spacing: 0;
}

.project-picker-actions {
  display: flex;
  flex-direction: column;
  flex: none;
  padding: 6px;
  border-top: 1px solid var(--color-border);
}

.project-list-empty {
  margin: 0;
  padding: 10px 14px 14px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}

</style>
