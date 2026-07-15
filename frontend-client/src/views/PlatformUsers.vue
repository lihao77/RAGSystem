<template>
  <PageLayout title="平台用户治理" subtitle="分别管理人类用户权限与跨租户机器人运行状态">
    <div class="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>用户 ({{ total }})</CardTitle>
          <CardDescription>管理人类用户状态、平台管理员权限与登录身份。</CardDescription>
        </CardHeader>
        <CardContent class="flex flex-col gap-4">
          <div class="flex flex-col gap-3 sm:flex-row">
            <Input v-model="query" placeholder="按用户 ID、名称或用户名搜索" @keyup.enter="loadDirectory" />
            <Button variant="outline" :disabled="loading" @click="loadDirectory">{{ loading ? '加载中...' : '查询' }}</Button>
          </div>
          <p v-if="loadError" class="text-sm text-destructive" role="alert">{{ loadError }}</p>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>平台角色</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead class="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableEmpty v-if="loading && users.length === 0" :colspan="5">正在加载用户...</TableEmpty>
                <TableRow v-for="platformUser in users" v-else :key="platformUser.id">
                  <TableCell>
                    <div class="font-medium">{{ platformUser.displayName }}</div>
                    <div class="text-xs text-muted-foreground">{{ platformUser.username || platformUser.id }}</div>
                  </TableCell>
                  <TableCell><Badge :variant="platformUser.status === 'active' ? 'secondary' : 'outline'">{{ platformUser.status === 'active' ? '正常' : '已禁用' }}</Badge></TableCell>
                  <TableCell><Badge :variant="platformUser.platformRole === 'admin' ? 'default' : 'outline'">{{ platformUser.platformRole === 'admin' ? '平台管理员' : '普通用户' }}</Badge></TableCell>
                  <TableCell>{{ formatDateTime(platformUser.createdAt) }}</TableCell>
                  <TableCell>
                    <div class="flex justify-end gap-2">
                      <Button size="sm" variant="outline" @click="openConfirm(platformUser, 'status', 'user')">{{ platformUser.status === 'active' ? '禁用' : '恢复' }}</Button>
                      <Button size="sm" :variant="platformUser.platformRole === 'admin' ? 'outline' : 'default'" @click="openConfirm(platformUser, 'role', 'user')">
                        {{ platformUser.platformRole === 'admin' ? '取消平台 admin' : '设为平台 admin' }}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                <TableEmpty v-if="!loading && users.length === 0" :colspan="5">暂无用户</TableEmpty>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>机器人 ({{ bots.length }})</CardTitle>
          <CardDescription>跨租户查看机器人归属、接入方式与运行开关；删除仍由 Owner 在机器人管理页执行。</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>机器人</TableHead>
                  <TableHead>所属租户</TableHead>
                  <TableHead>所属用户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>飞书</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead class="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableEmpty v-if="loading && bots.length === 0" :colspan="8">正在加载机器人...</TableEmpty>
                <TableRow v-for="bot in bots" v-else :key="bot.id">
                  <TableCell>
                    <div class="font-medium">{{ bot.displayName }}</div>
                    <div class="text-xs text-muted-foreground">{{ bot.id }}</div>
                  </TableCell>
                  <TableCell>
                    <div>{{ bot.tenantName }}</div>
                    <div class="text-xs text-muted-foreground">{{ bot.tenantId }}</div>
                  </TableCell>
                  <TableCell>{{ bot.ownerName }}</TableCell>
                  <TableCell><Badge :variant="bot.status === 'active' ? 'secondary' : 'outline'">{{ bot.status === 'active' ? '正常' : '已禁用' }}</Badge></TableCell>
                  <TableCell><Badge :variant="bot.feishuEnabled ? 'secondary' : 'outline'">{{ feishuLabel(bot) }}</Badge></TableCell>
                  <TableCell><Badge :variant="bot.enabled ? 'default' : 'outline'">{{ bot.enabled ? '已启用' : '已停用' }}</Badge></TableCell>
                  <TableCell>{{ formatDateTime(bot.createdAt) }}</TableCell>
                  <TableCell class="text-right">
                    <Button size="sm" variant="outline" @click="openConfirm(bot, 'status', 'bot')">{{ bot.status === 'active' ? '禁用' : '恢复' }}</Button>
                  </TableCell>
                </TableRow>
                <TableEmpty v-if="!loading && bots.length === 0" :colspan="8">暂无机器人</TableEmpty>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>

    <AlertDialog :open="Boolean(target)" @update:open="(open) => { if (!open) closeConfirm() }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ confirmTitle }}</AlertDialogTitle>
          <AlertDialogDescription>{{ confirmDescription }}</AlertDialogDescription>
        </AlertDialogHeader>
        <p v-if="mutationError" class="text-sm text-destructive" role="alert">{{ mutationError }}</p>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="updating">取消</AlertDialogCancel>
          <Button :disabled="updating" @click="confirmChange">{{ updating ? '处理中…' : '确认' }}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { listPlatformBots, listPlatformUsers, setPlatformUserRole, setPlatformUserStatus } from '../api/platform.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useAuthStore } from '../stores/auth.js';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import PageLayout from '../components/PageLayout.vue';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';

const router = useRouter();
const authStore = useAuthStore();
const users = ref([]);
const bots = ref([]);
const total = ref(0);
const query = ref('');
const target = ref(null);
const targetKind = ref('user');
const actionType = ref('');

const targetLabel = computed(() => targetKind.value === 'bot' ? '机器人' : '用户');
const confirmTitle = computed(() => {
  if (!target.value) return '';
  if (actionType.value === 'status') return `${target.value.status === 'active' ? '禁用' : '恢复'}${targetLabel.value}`;
  return target.value.platformRole === 'admin' ? '取消平台管理员' : '授予平台管理员';
});
const confirmDescription = computed(() => {
  if (!target.value) return '';
  if (actionType.value === 'status' && targetKind.value === 'bot') return target.value.status === 'active'
    ? '禁用后，该机器人不会再被执行引擎加载。'
    : '恢复后，已启用的机器人可重新被执行引擎加载。';
  if (actionType.value === 'status') return target.value.status === 'active'
    ? '禁用后，该用户的旧 token 在下一次请求时立即失效。'
    : '恢复后，该用户可重新登录和访问有效租户。';
  return target.value.platformRole === 'admin'
    ? '系统会拒绝撤销最后一个 active 平台管理员。'
    : '授予后，该用户可跨租户查看和执行平台治理操作。';
});

const { run: runLoad, loading, error: loadError } = useAsyncAction(
  async () => {
    const [userResponse, botItems] = await Promise.all([
      listPlatformUsers({ limit: 100, query: query.value.trim() || undefined }),
      listPlatformBots(),
    ]);
    return { userResponse, botItems };
  },
  { showErrorToast: false, errorPrefix: '加载用户与机器人失败' },
);
const { run: runUpdate, loading: updating, error: mutationError } = useAsyncAction(
  async (item, type) => {
    if (type === 'status') return setPlatformUserStatus(item.id, item.status === 'active' ? 'disabled' : 'active');
    return setPlatformUserRole(item.id, item.platformRole === 'admin' ? null : 'admin');
  },
  { successMessage: '平台状态已更新', errorPrefix: '更新状态失败' },
);

async function loadDirectory() {
  const response = await runLoad();
  if (!response) return;
  users.value = response.userResponse.users || response.userResponse.items || [];
  total.value = response.userResponse.total || 0;
  bots.value = response.botItems;
}

function openConfirm(item, type, kind) {
  target.value = item;
  targetKind.value = kind;
  actionType.value = type;
}

function closeConfirm() {
  target.value = null;
  targetKind.value = 'user';
  actionType.value = '';
}

async function confirmChange() {
  if (!target.value) return;
  const changedUserId = target.value.id;
  const changedKind = targetKind.value;
  const response = await runUpdate(target.value, actionType.value);
  if (!response) return;
  closeConfirm();
  if (changedKind === 'user' && changedUserId === authStore.user?.id) {
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
  await loadDirectory();
}

function feishuLabel(bot) {
  if (!bot.feishuEnabled) return '未接入';
  return bot.feishuReceiveMode === 'long_connection' ? '已接入长连接' : '已接入 Webhook';
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString() : '—';
}

onMounted(loadDirectory);
</script>
