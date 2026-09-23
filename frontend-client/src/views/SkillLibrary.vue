<template>
  <PageLayout title="Skill 库" subtitle="管理可复用的知识、流程和脚本；保存后生效" fill>
    <template #header-actions>
      <Button variant="outline" size="sm" :disabled="loading || busy" @click="actions.refreshAll"><RefreshCw data-icon="inline-start" />刷新</Button>
      <template v-if="canManage">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm" :disabled="busy || loading"><Upload data-icon="inline-start" />导入</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>导入来源</DropdownMenuLabel>
            <DropdownMenuItem @select="importJsonInput?.click()"><FileJson />JSON 备份</DropdownMenuItem>
            <DropdownMenuItem @select="importZipInput?.click()"><FileArchive />ZIP 压缩包</DropdownMenuItem>
            <DropdownMenuItem v-if="supportsDirectoryPick" @select="importFolderInput?.click()"><Folder />文件夹</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <input ref="importJsonInput" class="sr-only" type="file" accept=".json,application/json" @change="actions.importSkill" />
        <input ref="importZipInput" class="sr-only" type="file" accept=".zip,application/zip,application/x-zip-compressed" @change="actions.importZipSkill" />
        <input ref="importFolderInput" class="sr-only" type="file" webkitdirectory directory @change="actions.importFolderSkill" />
        <Button size="sm" :disabled="busy || loading" @click="actions.openCreate"><Plus data-icon="inline-start" />新建 Skill</Button>
      </template>
    </template>
    <Alert v-if="error" variant="destructive" class="shrink-0"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{{ error }}</AlertDescription></Alert>
    <div class="wb-workbench wb-workbench--fill" aria-label="Skill 管理工作区">
      <SkillNavigatorPanel v-if="!isNarrow" class="wb-workbench__nav" :state="state" :select-skill="actions.selectSkill" :handle-refresh="actions.refreshAll" :set-search-query="(value) => searchQuery = value" />
      <Card class="wb-workbench__main">
        <CardHeader class="shrink-0 gap-3">
          <div class="flex min-w-0 items-center justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2">
              <Sheet v-if="isNarrow" v-model:open="skillPickerOpen">
                <SheetTrigger as-child>
                  <Button variant="ghost" size="sm" class="min-w-0" aria-label="选择 Skill" :title="activeSkill?.name">
                    <ListFilter data-icon="inline-start" /><span class="truncate">{{ activeSkill?.name || '选择 Skill' }}</span><ChevronDown data-icon="inline-end" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" class="flex w-[min(88vw,360px)] flex-col gap-0 p-0">
                  <SheetHeader class="shrink-0 px-5 pb-2 pt-5">
                    <SheetTitle>选择 Skill</SheetTitle>
                    <SheetDescription class="sr-only">搜索并选择要查看或编辑的 Skill。</SheetDescription>
                  </SheetHeader>
                  <SkillNavigatorPanel embedded class="flex-1" :state="state" :select-skill="selectMobileSkill" :handle-refresh="actions.refreshAll" :set-search-query="(value) => searchQuery = value" />
                </SheetContent>
              </Sheet>
              <CardTitle v-else class="truncate" :title="activeSkill?.name">{{ activeSkill?.name || '选择一个 Skill' }}</CardTitle>
              <Badge v-if="hasUnsavedChanges" variant="warning" class="shrink-0">未保存</Badge>
              <Badge v-else-if="activeSkill && !canEdit" variant="secondary" class="shrink-0">只读</Badge>
              <span class="inline-flex size-4 shrink-0">
                <span v-if="loading && activeSkill" class="skill-loading-indicator" role="status" aria-label="正在加载 Skill"><Spinner /></span>
              </span>
            </div>
            <DropdownMenu v-if="activeSkill">
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-sm" class="shrink-0" :disabled="busy || loading" aria-label="Skill 更多操作" title="更多操作"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Skill</DropdownMenuLabel>
                  <DropdownMenuItem @select="actions.exportSkill"><Download />导出 JSON</DropdownMenuItem>
                  <DropdownMenuItem @select="actions.exportSkillZip"><FileArchive />导出 ZIP</DropdownMenuItem>
                  <DropdownMenuItem v-if="canEdit" @select="actions.remove"><Trash2 />删除 Skill</DropdownMenuItem>
                </DropdownMenuGroup>
                <template v-if="canEdit || selectedFile">
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>文件</DropdownMenuLabel>
                    <template v-if="canEdit">
                      <DropdownMenuItem @select="actions.openCreateFile"><FilePlus2 />新建文本文件</DropdownMenuItem>
                      <DropdownMenuItem @select="fileUploadInput?.click()"><Upload />上传文件</DropdownMenuItem>
                    </template>
                    <DropdownMenuItem v-if="selectedFile" @select="actions.downloadFile"><Download />下载当前文件</DropdownMenuItem>
                    <DropdownMenuItem v-if="canEdit && selectedFile && selectedFilePath !== 'SKILL.md'" @select="actions.removeFile"><Trash2 />删除当前文件</DropdownMenuItem>
                  </DropdownMenuGroup>
                </template>
              </DropdownMenuContent>
            </DropdownMenu>
            <input v-if="canEdit" ref="fileUploadInput" class="sr-only" type="file" @change="actions.upload" />
          </div>
          <CardDescription v-if="!activeSkill">选择一个 Skill，或新建 Skill。</CardDescription>
          <div v-else class="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl v-model="editorMode" :options="modeOptions" aria-label="文件查看模式" />
            <Button v-if="canEdit" class="ml-auto" size="sm" :disabled="busy || loading || !hasUnsavedChanges" @click="actions.save"><Spinner v-if="busy" data-icon="inline-start" /><Save v-else data-icon="inline-start" />保存并生效</Button>
          </div>
        </CardHeader>
        <CardContent class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div v-if="loading && !activeSkill" class="adm-state"><Spinner /><span>加载 Skill</span></div>
          <Empty v-else-if="!activeSkill"><EmptyHeader><EmptyTitle>选择一个 Skill</EmptyTitle></EmptyHeader></Empty>
          <BundleFilesPane v-else :state="state" :compact="isNarrow" :select-file="actions.selectFile" :toggle-directory="actions.toggleDirectory"
            @update:file-tree-open="(value) => fileTreeOpen = value"
            :set-file-text="(value) => fileText = value" />
        </CardContent>
      </Card>
    </div>
    <FormDialog :open="createDialog.open" title="新建 Skill" description="填写名称和描述后，在编辑器中编写使用说明。保存前不会进入可用 Skill 列表。"
      confirm-text="开始编辑" :confirm-disabled="!canCreate" :busy="busy" @update:open="(open) => createDialog.open = open" @submit="actions.create">
      <FieldGroup>
        <Field><FieldLabel for="skill-name">名称</FieldLabel><Input id="skill-name" v-model.trim="createDialog.name" maxlength="64" /><FieldDescription>小写字母、数字和连字符，保存后不可更改。</FieldDescription></Field>
        <Field><FieldLabel for="skill-description">描述</FieldLabel><Textarea id="skill-description" v-model="createDialog.description" maxlength="1000" /></Field>
      </FieldGroup>
    </FormDialog>
    <FormDialog :open="createFileDialog.open" title="新建文本文件" description="文件与当前 Skill 一起保存生效。" confirm-text="添加"
      :confirm-disabled="!canCreateFile" :error="createFileDialog.error" @update:open="(open) => createFileDialog.open = open" @submit="actions.createFile">
      <FieldGroup>
        <Field><FieldLabel for="skill-file-path">相对路径</FieldLabel><Input id="skill-file-path" v-model.trim="createFileDialog.path" placeholder="scripts/example.py" /></Field>
        <Field><FieldLabel for="skill-file-content">内容</FieldLabel><Textarea id="skill-file-content" v-model="createFileDialog.content" class="min-h-[180px]" /></Field>
      </FieldGroup>
    </FormDialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { onBeforeRouteLeave } from 'vue-router';
import { ChevronDown, Download, FileArchive, FileJson, FilePlus2, Folder, ListFilter, MoreHorizontal, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-vue-next';
import PageLayout from '../components/PageLayout.vue';
import FormDialog from '../components/admin/FormDialog.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import SkillNavigatorPanel from '../components/skill-library/SkillNavigatorPanel.vue';
import BundleFilesPane from '../components/skill-library/BundleFilesPane.vue';
import { Alert, AlertTitle, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '../components/ui/card';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator } from '../components/ui/dropdown-menu';
import { Empty, EmptyHeader, EmptyTitle } from '../components/ui/empty';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../components/ui/field';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Spinner } from '../components/ui/spinner';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../components/ui/sheet';
import { createSkillLibraryState } from '../composables/skill-library/state.js';
import { useSkillLibrary } from '../composables/skill-library/useSkillLibrary.js';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';

const state = createSkillLibraryState();
const actions = useSkillLibrary(state, { toast: useToast(), confirm: useConfirm().confirm });
const { canManage, canEdit, activeSkill, loading, busy, error, hasUnsavedChanges, searchQuery,
  editorMode, fileText, selectedFile, selectedFilePath, fileTreeOpen, createDialog, canCreate, createFileDialog, canCreateFile } = state;
const importJsonInput = ref(null);
const importZipInput = ref(null);
const importFolderInput = ref(null);
const fileUploadInput = ref(null);
const isNarrow = useMediaQuery('(max-width: 1024px)');
// 不支持 webkitdirectory 的浏览器（如 iOS Safari）会退化成单文件选择，造成“静默部分导入”，直接隐藏该入口。
const supportsDirectoryPick = typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input');
const skillPickerOpen = ref(false);
watch(isNarrow, (narrow) => {
  state.fileTreeOpen.value = !narrow;
  skillPickerOpen.value = false;
}, { immediate: true });
async function selectMobileSkill(skill) {
  if (await actions.selectSkill(skill)) skillPickerOpen.value = false;
}
const modeOptions = computed(() => [{ value: 'edit', label: canEdit.value ? '编辑文件' : '文件' }, { value: 'preview', label: '预览' }]);
function beforeUnload(event) { if (hasUnsavedChanges.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { actions.refreshAll(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
onBeforeRouteLeave(() => actions.allowDiscardChanges());
</script>

<style scoped>
.skill-loading-indicator {
  display: inline-flex;
  animation: skill-loading-appear 100ms ease 150ms both;
}

@keyframes skill-loading-appear {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 1024px) {
  .wb-workbench--fill {
    grid-template-rows: minmax(0, 1fr);
    overflow: hidden;
  }
}
</style>
