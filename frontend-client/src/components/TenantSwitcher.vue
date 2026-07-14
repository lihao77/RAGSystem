<template>
  <div v-if="showSwitcher" class="flex items-center gap-2">
    <Select v-if="tenants.length > 1" :model-value="authStore.tenantId" :disabled="switching || creating" @update:model-value="handleTenantChange">
      <SelectTrigger class="w-44" aria-label="切换租户">
        <SelectValue placeholder="选择租户" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem v-for="tenant in tenants" :key="tenant.id" :value="tenant.id">
            {{ tenant.displayName }}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>

    <Button v-if="isOwner" variant="outline" size="sm" :disabled="switching || creating" @click="openCreateDialog">
      新建租户
    </Button>
  </div>

  <Dialog :open="createOpen" @update:open="createOpen = $event">
    <DialogContent>
      <form class="flex flex-col gap-5" @submit.prevent="submitCreate">
        <DialogHeader>
          <DialogTitle>新建租户</DialogTitle>
          <DialogDescription>创建后将自动切换到新租户，并重新加载工作台数据。</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-2">
          <label for="tenant-display-name" class="text-sm font-medium">租户名称</label>
          <Input id="tenant-display-name" v-model="displayName" required autofocus />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="creating" @click="createOpen = false">取消</Button>
          <Button type="submit" :disabled="creating || !displayName.trim()">
            {{ creating ? '创建中...' : '创建并切换' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { createTenant, listTenants } from '../api/admin.js';
import { switchTenant } from '../api/auth.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useAuthStore } from '../stores/auth.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select';

const authStore = useAuthStore();
const bootstrapStore = useBootstrapStore();
const tenants = ref([]);
const createOpen = ref(false);
const displayName = ref('');

const isSaasLogin = computed(() => authStore.isAuthenticated && bootstrapStore.profile.auth === 'password');
const isOwner = computed(() => authStore.role === 'owner');
const showSwitcher = computed(() => isSaasLogin.value && (tenants.value.length > 1 || isOwner.value));

const { run: loadTenants } = useAsyncAction(
  async () => {
    tenants.value = await listTenants();
    return tenants.value;
  },
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
    const tenant = await createTenant(displayName.value.trim());
    const session = await switchTenant(tenant.id);
    authStore.setSession(session);
    await bootstrapStore.load(true);
    window.location.reload();
  },
  { errorPrefix: '创建租户失败' },
);

function handleTenantChange(tenantId) {
  if (!tenantId || tenantId === authStore.tenantId || switching.value || creating.value) return;
  runSwitch(tenantId);
}

function openCreateDialog() {
  displayName.value = '';
  createOpen.value = true;
}

function submitCreate() {
  if (!isOwner.value || !displayName.value.trim()) return;
  runCreate();
}

onMounted(() => {
  if (isSaasLogin.value) loadTenants();
});
</script>
