<template>
  <div class="flex flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>平台租户治理</CardTitle>
        <CardDescription>跨租户查看运行状态，并暂停或恢复租户访问。</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="flex flex-col gap-3 sm:flex-row">
          <Input v-model="query" placeholder="按租户 ID 或名称搜索" @keyup.enter="loadTenants" />
          <Button variant="outline" :disabled="loading" @click="loadTenants">{{ loading ? '加载中...' : '查询' }}</Button>
        </div>
        <p v-if="loadError" class="text-sm text-destructive" role="alert">{{ loadError }}</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>租户</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead class="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="tenant in tenants" :key="tenant.id">
              <TableCell>
                <div class="font-medium">{{ tenant.displayName }}</div>
                <div class="text-xs text-muted-foreground">{{ tenant.id }}</div>
              </TableCell>
              <TableCell><Badge :variant="tenant.status === 'active' ? 'secondary' : 'outline'">{{ tenant.status === 'active' ? '正常' : '已暂停' }}</Badge></TableCell>
              <TableCell>{{ formatDate(tenant.createdAt) }}</TableCell>
              <TableCell class="text-right">
                <Button size="sm" :variant="tenant.status === 'active' ? 'outline' : 'default'" @click="openConfirm(tenant)">
                  {{ tenant.status === 'active' ? '暂停' : '恢复' }}
                </Button>
              </TableCell>
            </TableRow>
            <TableEmpty v-if="!loading && tenants.length === 0" :colspan="4">暂无租户</TableEmpty>
          </TableBody>
        </Table>
        <div class="text-sm text-muted-foreground">共 {{ total }} 个租户</div>
      </CardContent>
    </Card>

    <AlertDialog :open="Boolean(target)" @update:open="(open) => { if (!open) target = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ target?.status === 'active' ? '暂停租户' : '恢复租户' }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ target?.status === 'active' ? '暂停后，该租户成员的现有 token 在新请求中也会被拒绝。' : '恢复后，租户成员可重新访问租户资源。' }}
          </AlertDialogDescription>
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
import { onMounted, ref } from 'vue';
import { listPlatformTenants, setPlatformTenantStatus } from '../api/platform.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';

const tenants = ref([]);
const total = ref(0);
const query = ref('');
const target = ref(null);

const { run: runLoad, loading, error: loadError } = useAsyncAction(
  () => listPlatformTenants({ limit: 100, query: query.value.trim() || undefined }),
  { showErrorToast: false, errorPrefix: '加载租户失败' },
);
const { run: runUpdate, loading: updating, error: mutationError } = useAsyncAction(
  (tenant, status) => setPlatformTenantStatus(tenant.id, status),
  { successMessage: '租户状态已更新', errorPrefix: '更新租户状态失败' },
);

async function loadTenants() {
  const response = await runLoad();
  if (!response) return;
  tenants.value = response.tenants || response.items || [];
  total.value = response.total || 0;
}

function openConfirm(tenant) {
  target.value = tenant;
}

async function confirmChange() {
  if (!target.value) return;
  const nextStatus = target.value.status === 'active' ? 'suspended' : 'active';
  const response = await runUpdate(target.value, nextStatus);
  if (!response) return;
  target.value = null;
  await loadTenants();
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(loadTenants);
</script>
