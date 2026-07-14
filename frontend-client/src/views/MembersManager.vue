<template>
  <PageLayout
    :embedded="embedded"
    :chat-return-path="chatReturnPath"
    title="成员管理"
    subtitle="查看当前租户成员，并按角色权限管理协作账号"
    mobile-title="成员管理"
  >
    <template v-if="canInvite" #header-actions>
      <Button size="sm" @click="openInviteDialog">邀请成员</Button>
    </template>

    <Card>
      <CardHeader>
        <CardTitle>租户成员</CardTitle>
        <CardDescription>
          当前角色：{{ roleLabels[authStore.role] || authStore.role || '未知' }}。成员可查看列表，管理操作仅对管理员和所有者开放。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>成员</TableHead>
                <TableHead>用户名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead v-if="showActions" class="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty v-if="loadingMembers" :colspan="columnCount">正在加载成员...</TableEmpty>
              <TableEmpty v-else-if="membersError" :colspan="columnCount">
                <div class="flex flex-col items-center gap-3">
                  <span>{{ membersError }}</span>
                  <Button variant="outline" size="sm" @click="refreshMembers">重试</Button>
                </div>
              </TableEmpty>
              <TableEmpty v-else-if="members.length === 0" :colspan="columnCount">当前租户暂无成员</TableEmpty>
              <TableRow v-for="member in members" v-else :key="member.userId">
                <TableCell>
                  <div class="flex flex-col gap-1">
                    <span class="font-medium">{{ member.user?.displayName || member.user?.username || member.userId }}</span>
                    <span v-if="member.userId === authStore.user?.id" class="text-xs text-muted-foreground">当前用户</span>
                  </div>
                </TableCell>
                <TableCell>{{ member.user?.username || '—' }}</TableCell>
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
            移除后，{{ removeTarget?.user?.displayName || removeTarget?.user?.username }} 将无法再访问当前租户。此操作不会删除用户账号。
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
const columnCount = computed(() => showActions.value ? 4 : 3);
const inviteRoleOptions = computed(() => authStore.role === 'owner' ? ownerRoleOptions : adminRoleOptions);

const { run: loadMembers, loading: loadingMembers, error: membersError } = useAsyncAction(
  async () => {
    members.value = await listMembers(authStore.tenantId);
    return members.value;
  },
  { showErrorToast: false, errorPrefix: '加载成员失败' },
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
    await loadMembers();
  },
  { successMessage: '成员邀请成功', errorPrefix: '邀请成员失败' },
);

const { run: runRoleChange, loading: updatingRole } = useAsyncAction(
  async () => {
    await updateMemberRole(authStore.tenantId, roleTarget.value.userId, selectedRole.value);
    roleOpen.value = false;
    roleTarget.value = null;
    await loadMembers();
  },
  { successMessage: '成员角色已更新', errorPrefix: '更新角色失败' },
);

const { run: runRemove, loading: removing } = useAsyncAction(
  async () => {
    await removeMember(authStore.tenantId, removeTarget.value.userId);
    removeOpen.value = false;
    removeTarget.value = null;
    await loadMembers();
  },
  { successMessage: '成员已移除', errorPrefix: '移除成员失败' },
);

function refreshMembers() {
  if (!authStore.tenantId) return;
  loadMembers();
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

onMounted(refreshMembers);
watch(() => authStore.tenantId, refreshMembers);
</script>
