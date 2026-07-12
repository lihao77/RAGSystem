<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="flex w-full flex-col p-0 sm:max-w-[1000px]">
      <SheetHeader class="border-b p-5">
        <SheetTitle>本轮文件变更</SheetTitle>
        <SheetDescription>最近一次 Agent 消息修改的文件与行级差异</SheetDescription>
      </SheetHeader>
      <div class="grid min-h-0 flex-1 md:grid-cols-[280px_minmax(0,1fr)]">
        <aside class="flex min-h-0 flex-col border-r">
          <div class="flex items-center justify-between border-b p-3">
            <span class="text-sm text-muted-foreground">{{ files.length }} 个文件</span>
            <Button variant="ghost" size="sm" :disabled="loading || !sessionId" @click="load"><IconRefresh :size="14" />刷新</Button>
          </div>
          <div class="min-h-0 flex-1 overflow-auto p-2">
            <Button v-for="file in files" :key="file.path" variant="ghost" class="mb-1 h-auto w-full justify-start gap-2 px-3 py-2 text-left" @click="selectedPath = file.path">
              <IconFile :size="14" class="flex-shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate" :title="file.path">{{ file.path }}</span>
              <Badge :variant="file.action === 'created' ? 'default' : 'secondary'">{{ actionLabel(file.action) }}</Badge>
            </Button>
            <p v-if="!loading && !files.length" class="p-4 text-center text-sm text-muted-foreground">本轮没有文件变更</p>
          </div>
        </aside>
        <main class="min-h-0 overflow-auto bg-muted/30">
          <div v-if="loading" class="p-8 text-center text-sm text-muted-foreground">加载变更中...</div>
          <div v-else-if="error" class="p-8 text-center text-sm text-destructive">{{ error }}</div>
          <div v-else-if="selectedFile" class="min-w-max font-mono text-xs leading-5">
            <div class="sticky top-0 border-b bg-background px-4 py-2 font-sans text-sm font-medium">{{ selectedFile.path }}</div>
            <div v-for="(line, index) in selectedFile.diff" :key="`${index}-${line.oldLine}-${line.newLine}`" :class="lineClass(line.type)" class="grid grid-cols-[48px_48px_20px_minmax(0,1fr)] border-b border-border/40">
              <span class="select-none border-r px-2 text-right text-muted-foreground">{{ line.oldLine ?? '' }}</span>
              <span class="select-none border-r px-2 text-right text-muted-foreground">{{ line.newLine ?? '' }}</span>
              <span class="select-none text-center">{{ lineMark(line.type) }}</span>
              <span class="whitespace-pre px-2">{{ line.content || ' ' }}</span>
            </div>
            <p v-if="!selectedFile.diff.length" class="p-8 text-center font-sans text-sm text-muted-foreground">文件内容没有差异</p>
          </div>
        </main>
      </div>
    </SheetContent>
  </Sheet>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { getLatestFileChanges } from '../../api/fileChanges.js';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import IconRefresh from '../icons/IconRefresh.vue';
import IconFile from '../icons/IconFile.vue';

const props = defineProps({ open: Boolean, sessionId: { type: String, default: '' } });
const emit = defineEmits(['update:open']);
const files = ref([]);
const loading = ref(false);
const error = ref('');
const selectedPath = ref('');
const selectedFile = computed(() => files.value.find(file => file.path === selectedPath.value) || files.value[0] || null);

async function load() {
  if (!props.sessionId) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await getLatestFileChanges(props.sessionId);
    files.value = result.files || [];
    if (!files.value.some(file => file.path === selectedPath.value)) selectedPath.value = files.value[0]?.path || '';
  } catch (loadError) {
    error.value = loadError.message || '加载文件变更失败';
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.sessionId], ([open]) => { if (open) load(); });
const actionLabel = action => action === 'created' ? '新增' : '修改';
const lineMark = type => type === 'added' ? '+' : type === 'removed' ? '-' : ' ';
const lineClass = type => ({
  'diff-line--added': type === 'added',
  'diff-line--removed': type === 'removed',
  'diff-line--context': type === 'context',
});
</script>

<style scoped>
.diff-line--added { background: rgba(var(--color-success-rgb), 0.12); }
.diff-line--removed { background: rgba(var(--color-error-rgb), 0.12); }
.diff-line--context { color: var(--color-text-muted); }
</style>
