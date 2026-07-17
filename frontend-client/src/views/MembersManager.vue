<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    title="成员管理"
    subtitle="分别管理租户成员角色与机器人租户归属"
    mobile-title="成员管理"
  >
    <template v-if="canInvite" #header-actions>
      <Button size="sm" @click="openInviteDialog">邀请成员</Button>
    </template>

    <div class="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>成员 ({{ members.length }})</CardTitle>
          <CardDescription>
            当前角色：{{ roleLabels[authStore.role] || authStore.role || '未知' }}。成员可查看列表，角色管理仅对管理员和所有者开放。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead v-if="showActions" class="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableEmpty v-if="loadingDirectory" :colspan="memberColumnCount">正在加载成员...</TableEmpty>
                <TableEmpty v-else-if="directoryError" :colspan="memberColumnCount">
                  <div class="flex flex-col items-center gap-3">
                    <span>{{ directoryError }}</span>
                    <Button variant="outline" size="sm" @click="refreshDirectory">重试</Button>
                  </div>
                </TableEmpty>
                <TableEmpty v-else-if="members.length === 0" :colspan="memberColumnCount">当前租户暂无成员</TableEmpty>
                <TableRow v-for="member in members" v-else :key="member.userId">
                  <TableCell>
                    <div class="flex flex-col gap-1">
                      <span class="font-medium">{{ member.user?.displayName || member.user?.username || member.userId }}</span>
                      <span class="text-xs text-muted-foreground">{{ member.userId }}</span>
                      <span v-if="member.userId === authStore.user?.id" class="text-xs text-muted-foreground">当前用户</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge :variant="roleBadgeVariant(member.role)">{{ roleLabels[member.role] || member.role }}</Badge>
                  </TableCell>
                  <TableCell v-if="showActions" class="text-right">
                    <div class="flex justify-end gap-2">
                      <Button v-if="canChangeRole" variant="outline" size="sm" @click="openRoleDialog(member)">修改角色</Button>
                      <Button
                        v-if="canRemove"
                        variant="destructive"
                        size="sm"
                        :disabled="member.userId === authStore.user?.id"
                        :title="member.userId === authStore.user?.id ? '不能移除自己' : '移除成员'"
                        @click="openRemoveDialog(member)"
                      >
                        移除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>机器人 ({{ bots.length }})</CardTitle>
          <CardDescription>机器人在此只读展示；停用由平台用户治理执行，删除由 Owner 在机器人管理页执行。</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>机器人</TableHead>
                  <TableHead>所属用户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>飞书</TableHead>
                  <TableHead>启用</TableHead>
                  <TableHead>创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableEmpty v-if="loadingDirectory" :colspan="6">正在加载机器人...</TableEmpty>
                <TableEmpty v-else-if="directoryError" :colspan="6">{{ directoryError }}</TableEmpty>
                <TableEmpty v-else-if="bots.length === 0" :colspan="6">当前租户暂无机器人</TableEmpty>
                <TableRow v-for="bot in bots" v-else :key="bot.id">
                  <TableCell>
                    <div class="font-medium">{{ bot.displayName }}</div>
                    <div class="text-xs text-muted-foreground">{{ bot.id }}</div>
                  </TableCell>
                  <TableCell>{{ bot.ownerName }}</TableCell>
                  <TableCell><Badge :variant="bot.status === 'active' ? 'secondary' : 'outline'">{{ bot.status === 'active' ? '正常' : '已禁用' }}</Badge></TableCell>
                  <TableCell><Badge :variant="bot.feishuEnabled ? 'secondary' : 'outline'">{{ feishuLabel(bot) }}</Badge></TableCell>
                  <TableCell><Badge :variant="bot.enabled ? 'default' : 'outline'">{{ bot.enabled ? '已启用' : '已停用' }}</Badge></TableCell>
                  <TableCell>{{ formatDateTime(bot.createdAt) }}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>

    <Dialog :open="inviteOpen" @update:open="inviteOpen = $event">
      <DialogContent>
        <form class="flex flex-col gap-5" @submit.prevent="submitInvite">
          <DialogHeader>
            <DialogTitle>邀请成员</DialogTitle>
            <DialogDescription>已有用户会直接加入当前租户；新用户名将创建对应账号。</DialogDescription>
          </DialogHeader>

          <div class="flex flex-col gap-2">
            <label for="member-username" class="text-sm font-medium">用户名</label>
            <Input id="member-username" v-model="inviteForm.username" autocomplete="username" required />
          </div>
          <div class="flex flex-col gap-2">
            <label for="member-display-name" class="text-sm font-medium">显示名称（可选）</label>
            <Input id="member-display-name" v-model="inviteForm.displayName" autocomplete="name" />
          </div>
          <div class="flex flex-col gap-2">
            <label for="member-password" class="text-sm font-medium">密码</label>
            <Input id="member-password" v-model="inviteForm.password" type="password" minlength="8" autocomplete="new-password" required />
          </div>
          <div class="flex flex-col gap-2">
            <label class="text-sm font-medium">角色</label>
            <Select v-model="inviteForm.role">
              <SelectTrigger>
                <SelectValue placeholder="请选择角色" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem v-for="option in inviteRoleOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" :disabled="inviting" @click="inviteOpen = false">取消</Button>
            <Button type="submit" :disabled="inviting || !inviteForm.username.trim() || inviteForm.password.length < 8">
              {{ inviting ? '邀请中...' : '确认邀请' }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog :open="roleOpen" @update:open="roleOpen = $event">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>修改成员角色</DialogTitle>
          <DialogDescription>为 {{ roleTarget?.user?.displayName || roleTarget?.user?.username }} 选择新角色。</DialogDescription>
        </DialogHeader>
        <div class="flex flex-col gap-2">
          <label class="text-sm font-medium">角色</label>
          <Select v-model="selectedRole">
            <SelectTrigger>
              <SelectValue placeholder="请选择角色" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem v-for="option in ownerRoleOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="updatingRole" @click="roleOpen = false">取消</Button>
          <Button :disabled="updatingRole || !roleTarget || selectedRole === roleTarget.role" @click="submitRoleChange">
            {{ updatingRole ? '保存中...' : '保存角色' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog :open="removeOpen" @update:open="removeOpen = $event">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确认移除成员</AlertDialogTitle>
          <AlertDialogDescription>
            {{ removeTargetName }} 将不再属于当前租户。此操作不会删除用户账号。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="removing">取消</AlertDialogCancel>
          <Button variant="destructive" :disabled="removing" @click="submitRemove">
            {{ removing ? '移除中...' : '确认移除' }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </PageLayout>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import PageLayout from '../components/PageLayout.vue';
import { useAuthStore } from '../stores/auth.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { inviteMember, listMembers, removeMember, updateMemberRole } from '../api/admin.js';
import { listTenantBots } from '../api/bots.js';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';

defineProps({
  embedded: { type: Boolean, default: false },
  chatReturnPath: { type: String, default: '/' },
});

const authStore = useAuthStore();
const members = ref([]);
const bots = ref([]);
const inviteOpen = ref(false);
const roleOpen = ref(false);
const removeOpen = ref(false);
const roleTarget = ref(null);
const removeTarget = ref(null);
const selectedRole = ref('member');
const inviteForm = reactive({ username: '', displayName: '', password: '', role: 'member' });

const roleLabels = { owner: '所有者', admin: '管理员', member: '成员' };
const ownerRoleOptions = [
  { value: 'member', label: '成员' },
  { value: 'admin', label: '管理员' },
  { value: 'owner', label: '所有者' },
];
const adminRoleOptions = ownerRoleOptions.filter((option) => option.value !== 'owner');

const canInvite = computed(() => authStore.role === 'owner' || authStore.role === 'admin');
const canChangeRole = computed(() => authStore.role === 'owner');
const canRemove = computed(() => authStore.role === 'owner' || authStore.role === 'admin');
const showActions = computed(() => canChangeRole.value || canRemove.value);
const memberColumnCount = computed(() => showActions.value ? 3 : 2);
const inviteRoleOptions = computed(() => authStore.role === 'owner' ? ownerRoleOptions : adminRoleOptions);
const removeTargetName = computed(() => removeTarget.value?.user?.displayName
  || removeTarget.value?.user?.username
  || removeTarget.value?.userId
  || '该对象');

const { run: loadDirectory, loading: loadingDirectory, error: directoryError } = useAsyncAction(
  async () => {
    const [memberItems, botItems] = await Promise.all([
      listMembers(authStore.tenantId),
      listTenantBots(),
    ]);
    members.value = memberItems;
    bots.value = botItems;
    return { memberItems, botItems };
  },
  { showErrorToast: false, errorPrefix: '加载成员与机器人失败' },
);

const { run: runInvite, loading: inviting } = useAsyncAction(
  async () => {
    const displayName = inviteForm.displayName.trim();
    await inviteMember(authStore.tenantId, {
      username: inviteForm.username.trim(),
      password: inviteForm.password,
      role: inviteForm.role,
      ...(displayName ? { displayName } : {}),
    });
    inviteOpen.value = false;
    resetInviteForm();
    await loadDirectory();
  },
  { successMessage: '成员邀请成功', errorPrefix: '邀请成员失败' },
);

const { run: runRoleChange, loading: updatingRole } = useAsyncAction(
  async () => {
    await updateMemberRole(authStore.tenantId, roleTarget.value.userId, selectedRole.value);
    roleOpen.value = false;
    roleTarget.value = null;
    await loadDirectory();
  },
  { successMessage: '成员角色已更新', errorPrefix: '更新角色失败' },
);

const { run: runRemove, loading: removing } = useAsyncAction(
  async () => {
    await removeMember(authStore.tenantId, removeTarget.value.userId);
    removeOpen.value = false;
    removeTarget.value = null;
    await loadDirectory();
  },
  { successMessage: '租户成员关系已移除', errorPrefix: '移除失败' },
);

function refreshDirectory() {
  if (!authStore.tenantId) return;
  loadDirectory();
}

function resetInviteForm() {
  inviteForm.username = '';
  inviteForm.displayName = '';
  inviteForm.password = '';
  inviteForm.role = 'member';
}

function openInviteDialog() {
  resetInviteForm();
  inviteOpen.value = true;
}

function submitInvite() {
  if (!canInvite.value || !inviteForm.username.trim() || inviteForm.password.length < 8) return;
  runInvite();
}

function openRoleDialog(member) {
  if (!canChangeRole.value) return;
  roleTarget.value = member;
  selectedRole.value = member.role;
  roleOpen.value = true;
}

function submitRoleChange() {
  if (!canChangeRole.value || !roleTarget.value || selectedRole.value === roleTarget.value.role) return;
  runRoleChange();
}

function openRemoveDialog(member) {
  if (!canRemove.value || member.userId === authStore.user?.id) return;
  removeTarget.value = member;
  removeOpen.value = true;
}

function submitRemove() {
  if (!canRemove.value || !removeTarget.value || removeTarget.value.userId === authStore.user?.id) return;
  runRemove();
}

function roleBadgeVariant(role) {
  if (role === 'owner') return 'default';
  if (role === 'admin') return 'secondary';
  return 'outline';
}

function feishuLabel(bot) {
  if (!bot.feishuEnabled) return '未接入';
  return bot.feishuReceiveMode === 'long_connection' ? '已接入长连接' : '已接入 Webhook';
}

onMounted(refreshDirectory);
watch(() => authStore.tenantId, refreshDirectory);
</script>
import { formatDateTime } from '../utils/datetime.js';
