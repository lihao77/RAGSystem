<template>
  <div class="flex flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>平台用户治理</CardTitle>
        <CardDescription>禁用或恢复用户，并管理跨租户平台管理员权限。</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="flex flex-col gap-3 sm:flex-row">
          <Input v-model="query" placeholder="按用户 ID、名称或用户名搜索" @keyup.enter="loadUsers" />
          <Button variant="outline" :disabled="loading" @click="loadUsers">{{ loading ? '加载中...' : '查询' }}</Button>
        </div>
        <p v-if="loadError" class="text-sm text-destructive" role="alert">{{ loadError }}</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>平台角色</TableHead>
              <TableHead class="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="platformUser in users" :key="platformUser.id">
              <TableCell>
                <div class="font-medium">{{ platformUser.displayName }}</div>
                <div class="text-xs text-muted-foreground">{{ platformUser.username || platformUser.id }}</div>
              </TableCell>
              <TableCell><Badge :variant="platformUser.status === 'active' ? 'secondary' : 'outline'">{{ platformUser.status === 'active' ? '正常' : '已禁用' }}</Badge></TableCell>
              <TableCell><Badge :variant="platformUser.platformRole === 'admin' ? 'default' : 'outline'">{{ platformUser.platformRole === 'admin' ? '平台管理员' : '普通用户' }}</Badge></TableCell>
              <TableCell>
                <div class="flex justify-end gap-2">
                  <Button size="sm" variant="outline" @click="openConfirm(platformUser, 'status')">{{ platformUser.status === 'active' ? '禁用' : '恢复' }}</Button>
                  <Button size="sm" :variant="platformUser.platformRole === 'admin' ? 'outline' : 'default'" @click="openConfirm(platformUser, 'role')">
                    {{ platformUser.platformRole === 'admin' ? '取消平台 admin' : '设为平台 admin' }}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
            <TableEmpty v-if="!loading && users.length === 0" :colspan="4">暂无用户</TableEmpty>
          </TableBody>
        </Table>
        <div class="text-sm text-muted-foreground">共 {{ total }} 个用户</div>
      </CardContent>
    </Card>

    <AlertDialog :open="Boolean(target)" @update:open="(open) => { if (!open) closeConfirm() }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ confirmTitle }}</AlertDialogTitle>
          <AlertDialogDescription>{{ confirmDescription }}</AlertDialogDescription>
        </AlertDialogHeader>
        <p v-if="mutationError" class="text-sm text-destructive" role="alert">{{ mutationError }}</p>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="updating">取消</AlertDialogCancel>
          <AlertDialogAction :disabled="updating" @click.prevent="confirmChange">{{ updating ? '处理中...' : '确认' }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { listPlatformUsers, setPlatformUserRole, setPlatformUserStatus } from '../api/platform.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useAuthStore } from '../stores/auth.js';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';

const router = useRouter();
const authStore = useAuthStore();
const users = ref([]);
const total = ref(0);
const query = ref('');
const target = ref(null);
const actionType = ref('');

const confirmTitle = computed(() => {
  if (!target.value) return '';
  if (actionType.value === 'status') return target.value.status === 'active' ? '禁用用户' : '恢复用户';
  return target.value.platformRole === 'admin' ? '取消平台管理员' : '授予平台管理员';
});
const confirmDescription = computed(() => {
  if (!target.value) return '';
  if (actionType.value === 'status') return target.value.status === 'active'
    ? '禁用后，该用户的旧 token 在下一次请求时立即失效。'
    : '恢复后，该用户可重新登录和访问有效租户。';
  return target.value.platformRole === 'admin'
    ? '系统会拒绝撤销最后一个 active 平台管理员。'
    : '授予后，该用户可跨租户查看和执行平台治理操作。';
});

const { run: runLoad, loading, error: loadError } = useAsyncAction(
  () => listPlatformUsers({ limit: 100, query: query.value.trim() || undefined }),
  { showErrorToast: false, errorPrefix: '加载用户失败' },
);
const { run: runUpdate, loading: updating, error: mutationError } = useAsyncAction(
  async (platformUser, type) => {
    if (type === 'status') {
      return setPlatformUserStatus(platformUser.id, platformUser.status === 'active' ? 'disabled' : 'active');
    }
    return setPlatformUserRole(platformUser.id, platformUser.platformRole === 'admin' ? null : 'admin');
  },
  { successMessage: '用户平台状态已更新', errorPrefix: '更新用户失败' },
);

async function loadUsers() {
  const response = await runLoad();
  if (!response) return;
  users.value = response.users || response.items || [];
  total.value = response.total || 0;
}

function openConfirm(platformUser, type) {
  target.value = platformUser;
  actionType.value = type;
}

function closeConfirm() {
  target.value = null;
  actionType.value = '';
}

async function confirmChange() {
  if (!target.value) return;
  const changedUserId = target.value.id;
  const response = await runUpdate(target.value, actionType.value);
  if (!response) return;
  closeConfirm();
  if (changedUserId === authStore.user?.id) {
    authStore.setSession({
      token: authStore.token,
      user: response.user,
      tenantId: authStore.tenantId,
      role: authStore.role,
      platformRole: response.user?.platformRole || '',
      identityLoaded: true,
    });
    if (!authStore.isPlatformAdmin) {
      await router.replace('/');
      return;
    }
  }
  await loadUsers();
}

onMounted(loadUsers);
</script>
