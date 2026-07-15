<template>
  <DropdownMenu v-if="showUserArea">
    <DropdownMenuTrigger as-child>
      <button class="user-trigger" :class="{ 'is-collapsed': collapsed }" :title="displayName" aria-label="账户菜单">
        <span class="user-avatar" aria-hidden="true">{{ initial }}</span>
        <span class="user-name">{{ displayName }}</span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="user-menu" :style="{ width: 'var(--reka-popper-anchor-width, 16rem)' }" align="start" side="top" :side-offset="10">
      <div class="user-head">
        <div class="user-head__name">{{ displayName }}</div>
        <div v-if="roleLabel" class="user-head__meta">{{ roleLabel }}</div>
      </div>
      <DropdownMenuSeparator />
      <template v-if="showTenantSwitcher">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Building class="mr-2 h-4 w-4" />
            切换租户
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent class="border-0">
            <DropdownMenuItem
              v-for="t in tenants"
              :key="t.id"
              :disabled="switching || creating || t.id === authStore.tenantId"
              @click="switchTo(t.id)"
            >
              <span class="truncate">{{ t.displayName }}</span>
              <IconCheck v-if="t.id === authStore.tenantId" :size="14" style="margin-left: auto" />
            </DropdownMenuItem>
            <DropdownMenuItem v-if="isPlatformAdmin" class="justify-center" @click="openCreate">
              <IconPlus :size="14" />
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
      </template>
      <DropdownMenuItem class="user-logout" :disabled="logoutLoading" @click="handleLogout">
        {{ logoutLoading ? '退出中…' : '退出登录' }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>

  <Dialog :open="createOpen" @update:open="createOpen = $event">
    <DialogContent>
      <form class="flex flex-col gap-5" @submit.prevent="submitCreate">
        <DialogHeader>
          <DialogTitle>新建租户</DialogTitle>
          <DialogDescription>创建后将自动切换到新租户，并重新加载工作台数据。</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-2">
          <label for="user-menu-tenant-name" class="text-sm font-medium">租户名称</label>
          <Input id="user-menu-tenant-name" v-model="displayNameInput" required autofocus />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" :disabled="creating" @click="createOpen = false">取消</Button>
          <Button type="submit" :disabled="creating || !displayNameInput.trim()">{{ creating ? '创建中…' : '创建并切换' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, inject, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { createTenant, listTenants } from '../api/admin.js';
import { logout, switchTenant } from '../api/auth.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useToast } from '../composables/useToast.js';
import { useAuthStore } from '../stores/auth.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import IconCheck from './icons/IconCheck.vue';
import IconPlus from './icons/IconPlus.vue';
import { Building } from 'lucide-vue-next';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Input } from './ui/input';

const router = useRouter();
const toast = useToast();
const authStore = useAuthStore();
const bootstrapStore = useBootstrapStore();
const collapsed = inject('sidebarCollapsed', ref(false));

const tenants = ref([]);
const createOpen = ref(false);
const displayNameInput = ref('');
const logoutLoading = ref(false);

const showUserArea = computed(() => bootstrapStore.requiresAuth && authStore.isAuthenticated);
const isSaasLogin = computed(() => authStore.isAuthenticated && bootstrapStore.profile.auth === 'password');
const isPlatformAdmin = computed(() => authStore.isPlatformAdmin);
const showTenantSwitcher = computed(() => isSaasLogin.value && (tenants.value.length > 1 || isPlatformAdmin.value));
const displayName = computed(() => authStore.user?.displayName || '用户');
const initial = computed(() => {
  const ch = (displayName.value.trim()[0] || '?');
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
});
const roleLabel = computed(() => {
  const parts = [];
  if (authStore.role) parts.push(authStore.role);
  if (authStore.isPlatformAdmin) parts.push('平台管理员');
  return parts.join(' · ');
});

const { run: loadTenants } = useAsyncAction(
  async () => { tenants.value = await listTenants(); return tenants.value; },
  { errorPrefix: '加载租户列表失败' },
);
const { run: runSwitch, loading: switching } = useAsyncAction(
  async (tenantId) => {
    const session = await switchTenant(tenantId);
    authStore.setSession(session);
    await bootstrapStore.load(true);
    window.location.reload();
  },
  { errorPrefix: '切换租户失败' },
);
const { run: runCreate, loading: creating } = useAsyncAction(
  async () => {
    const tenant = await createTenant(displayNameInput.value.trim());
    const session = await switchTenant(tenant.id);
    authStore.setSession(session);
    await bootstrapStore.load(true);
    window.location.reload();
  },
  { errorPrefix: '创建租户失败' },
);

function switchTo(tenantId) {
  if (!tenantId || tenantId === authStore.tenantId || switching.value || creating.value) return;
  runSwitch(tenantId);
}
function openCreate() {
  displayNameInput.value = '';
  createOpen.value = true;
}
function submitCreate() {
  if (!isPlatformAdmin.value || !displayNameInput.value.trim()) return;
  runCreate();
}
async function handleLogout() {
  logoutLoading.value = true;
  try {
    await logout();
  } catch (error) {
    toast.warning(error?.message || '服务端退出失败，已清除本地登录状态');
  } finally {
    authStore.clear();
    logoutLoading.value = false;
    await router.replace('/login');
  }
}

onMounted(() => {
  if (isSaasLogin.value) loadTenants();
});
</script>

<style scoped>
.user-trigger {
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
.user-trigger:hover { background: var(--color-hover-overlay-md); }
.user-trigger.is-collapsed { justify-content: center; padding: var(--spacing-xs); }

.user-avatar {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(var(--color-brand-accent-rgb), 0.16);
  color: var(--color-brand-accent);
  font-size: var(--font-size-xs);
  font-weight: 700;
}
.user-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.user-trigger.is-collapsed .user-name { display: none; }

.user-head { padding: var(--spacing-xs) var(--spacing-sm); display: flex; flex-direction: column; gap: 2px; }
.user-head__name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-head__meta { font-size: var(--font-size-xs); color: var(--color-text-muted); }
.tenant-check { width: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--color-brand-accent); flex-shrink: 0; }
.user-logout { color: var(--color-danger); }
</style>
