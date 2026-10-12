<template>
  <DropdownMenu v-model:open="menuOpen">
    <DropdownMenuTrigger as-child>
      <button
        class="scene-trigger"
        :title="currentSceneName"
        :aria-label="`场景菜单：${currentSceneName}`"
      >
        <span class="scene-icon" aria-hidden="true"><Layers :size="16" /></span>
        <span class="scene-name">{{ currentSceneName }}</span>
        <IconChevronDown class="scene-caret" :size="14" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="scene-menu" :style="{ width: 'var(--reka-popper-anchor-width, 16rem)' }" align="start" side="top" :side-offset="10">
      <div class="scene-head">
        <div class="scene-head__label">当前场景</div>
        <div class="scene-head__name">{{ currentSceneName }}</div>
      </div>
      <DropdownMenuSeparator />
      <!-- 不对当前场景行整体 disabled（会连带 pointer-events-none 压掉行内重命名按钮）；
           switchTo 对当前场景自身空操作，防误切由其内部守卫承担。 -->
      <DropdownMenuItem
        v-for="scene in scenes"
        :key="scene.id"
        class="scene-item"
        :disabled="busy"
        @click="switchTo(scene.id)"
      >
        <span class="truncate scene-item__name" :title="scene.displayName">{{ scene.displayName }}</span>
        <span class="scene-item__actions">
          <button class="scene-action" aria-label="重命名场景" :disabled="busy" @click.stop="openRename(scene)">
            <Pencil :size="14" />
          </button>
          <button
            v-if="scenes.length > 1 && scene.id !== activeTenantId"
            class="scene-action scene-action--danger"
            aria-label="删除场景"
            :disabled="busy"
            @click.stop="removeScene(scene)"
          >
            <Trash2 :size="14" />
          </button>
        </span>
        <IconCheck v-if="scene.id === activeTenantId" :size="14" class="scene-item__check" />
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem class="scene-create" :disabled="busy" @click="openCreate">
        <IconPlus :size="14" />
        <span>新建场景</span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <Dialog :open="createOpen" @update:open="createOpen = $event">
    <DialogContent>
      <form class="flex flex-col gap-5" @submit.prevent="submitCreate">
        <DialogHeader>
          <DialogTitle>新建场景</DialogTitle>
          <DialogDescription>创建后将自动切换到新场景，并重新加载工作台数据。</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-2">
          <label for="scene-switcher-create-name" class="text-sm font-medium">场景名称</label>
          <Input id="scene-switcher-create-name" v-model="createNameInput" required autofocus />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" :disabled="creating" @click="createOpen = false">取消</Button>
          <Button type="submit" :disabled="creating || !createNameInput.trim()">{{ creating ? '创建中…' : '创建并切换' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog :open="renameOpen" @update:open="renameOpen = $event">
    <DialogContent>
      <form class="flex flex-col gap-5" @submit.prevent="submitRename">
        <DialogHeader>
          <DialogTitle>重命名场景</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-2">
          <label for="scene-switcher-rename-name" class="text-sm font-medium">场景名称</label>
          <Input id="scene-switcher-rename-name" v-model="renameNameInput" required autofocus />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" :disabled="renaming" @click="renameOpen = false">取消</Button>
          <Button type="submit" :disabled="renaming || !renameNameInput.trim()">{{ renaming ? '保存中…' : '保存' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { Layers, Pencil, Trash2 } from 'lucide-vue-next';
import { activateScene, createScene, deleteScene, listScenes, renameScene } from '../api/localScenes.ts';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import IconCheck from './icons/IconCheck.vue';
import IconChevronDown from './icons/IconChevronDown.vue';
import IconPlus from './icons/IconPlus.vue';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Input } from './ui/input';

const { confirm } = useConfirm();
const bootstrapStore = useBootstrapStore();

const scenes = ref([]);
const activeTenantId = ref('');
const menuOpen = ref(false);
const createOpen = ref(false);
const createNameInput = ref('');
const renameOpen = ref(false);
const renameNameInput = ref('');
const renameTarget = ref(null);

// 本地场景是本地部署专属能力。按约定能力显隐应走 bootstrap capabilities，
// 但为避免为此在 core 增加仅本地使用的 capability 字段，这里直接以 profile.auth 判定
// （与后端插件启用条件 deployment=local && auth=local 一致：auth=local 仅存在于本地部署）。
const visible = computed(() => bootstrapStore.loaded && bootstrapStore.profile.auth === 'local');
const currentSceneName = computed(() =>
  scenes.value.find((scene) => scene.id === activeTenantId.value)?.displayName || '场景');

const { run: loadScenes } = useAsyncAction(
  async () => {
    const response = await listScenes();
    scenes.value = response.scenes || [];
    activeTenantId.value = response.activeTenantId || '';
    return response;
  },
  { errorPrefix: '加载场景列表失败' },
);
const { run: runSwitch, loading: switching } = useAsyncAction(
  async (sceneId) => {
    await activateScene(sceneId);
    await reloadWorkbench();
  },
  { errorPrefix: '切换场景失败' },
);
const { run: runCreate, loading: creating } = useAsyncAction(
  async () => {
    const { scene } = await createScene({ displayName: createNameInput.value.trim() });
    await activateScene(scene.id);
    await reloadWorkbench();
  },
  {
    errorPrefix: '创建场景失败',
    // 创建成功但激活失败时场景已存在，刷新列表让用户能看到并手动切换。
    onError: () => { void loadScenes(); },
  },
);
const { run: runRename, loading: renaming } = useAsyncAction(
  async () => {
    if (!renameTarget.value) return;
    await renameScene(renameTarget.value.id, { displayName: renameNameInput.value.trim() });
    await loadScenes();
  },
  {
    errorPrefix: '重命名场景失败',
    onSuccess: () => { renameOpen.value = false; },
  },
);
const { run: runRemove, loading: deleting } = useAsyncAction(
  async (scene) => {
    const accepted = await confirm({
      title: '删除场景',
      message: `确定要删除场景“${scene.displayName}”吗？该场景的全部数据（会话、知识库、文件与配置）将被永久删除，此操作不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!accepted) return;
    await deleteScene(scene.id);
    await loadScenes();
  },
  { successMessage: () => '场景已删除' },
  );

const busy = computed(() => switching.value || creating.value || renaming.value || deleting.value);

async function reloadWorkbench() {
  await bootstrapStore.load(true);
  // 整页刷新：chat SDK、WebSocket、会话列表等全部按新场景重建。
  window.location.reload();
}

function closeMenu() {
  menuOpen.value = false;
}
function switchTo(sceneId) {
  if (!sceneId || sceneId === activeTenantId.value || busy.value) return;
  runSwitch(sceneId);
}
function openCreate() {
  closeMenu();
  createNameInput.value = '';
  createOpen.value = true;
}
function submitCreate() {
  if (busy.value || !createNameInput.value.trim()) return;
  runCreate();
}
function openRename(scene) {
  closeMenu();
  renameTarget.value = scene;
  renameNameInput.value = scene.displayName;
  renameOpen.value = true;
}
function submitRename() {
  if (busy.value || !renameTarget.value || !renameNameInput.value.trim()) return;
  runRename();
}
function removeScene(scene) {
  closeMenu();
  runRemove(scene);
}

onMounted(() => {
  if (visible.value) loadScenes();
});
</script>

<style scoped>
.scene-trigger {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
  min-width: 0;
  padding: var(--spacing-xs) var(--spacing-sm);
  border: none;
  background: none;
  color: var(--color-text-primary);
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.scene-trigger:hover { background: var(--color-hover-overlay-md); }

.scene-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-full);
  background: rgba(var(--color-brand-accent-rgb), 0.16);
  color: var(--color-brand-accent);
}
.scene-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scene-caret { flex-shrink: 0; color: var(--color-text-muted); }

.scene-head { padding: var(--spacing-xs) var(--spacing-sm); display: flex; flex-direction: column; gap: 2px; }
.scene-head__label { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.scene-head__name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.scene-item__name { flex: 1; min-width: 0; }
.scene-item__actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.scene-item:hover .scene-item__actions,
.scene-item:focus-visible .scene-item__actions { opacity: 1; }
.scene-item__check { flex-shrink: 0; color: var(--color-brand-accent); }

.scene-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-md);
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
}
.scene-action:hover { background: var(--color-hover-overlay-md); color: var(--color-text-primary); }
.scene-action--danger:hover { color: var(--color-danger); }

.scene-create { justify-content: center; gap: var(--spacing-xs); color: var(--color-brand-accent); }
</style>
