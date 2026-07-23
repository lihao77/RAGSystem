<template>
  <DropdownMenuSub v-if="presentation === 'submenu'">
    <DropdownMenuSubTrigger
      class="data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
      :disabled="!sessionId"
      :title="triggerTitle"
    >
      <ShieldCheck />
      <span class="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span>会话权限</span>
        <span class="text-xs text-muted-foreground">{{ modeLabel }}</span>
      </span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent class="w-72">
      <DropdownMenuLabel>
        <span class="flex flex-col gap-1">
          <span>会话权限</span>
          <span class="text-xs font-normal text-muted-foreground">
            {{ canEdit ? '仅影响当前会话，修改后立即持久化。' : '当前会话归属其他身份，仅可查看。' }}
          </span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuRadioGroup :model-value="currentMode" @update:model-value="selectMode">
          <DropdownMenuRadioItem
            v-for="mode in modes"
            :key="mode.value"
            :value="mode.value"
            :disabled="!canEdit || updateAction.loading.value"
          >
            <span class="flex flex-col gap-0.5">
              <span>{{ mode.label }}</span>
              <span class="text-xs text-muted-foreground">{{ mode.description }}</span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenu v-else>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="sm"
        :disabled="!sessionId"
        :title="triggerTitle"
      >
        <ShieldCheck data-icon="inline-start" />
        {{ modeLabel }}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-72">
      <DropdownMenuLabel>
        <span class="flex flex-col gap-1">
          <span>会话权限</span>
          <span class="text-xs font-normal text-muted-foreground">
            {{ canEdit ? '仅影响当前会话，修改后立即持久化。' : '当前会话归属其他身份，仅可查看。' }}
          </span>
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuRadioGroup :model-value="currentMode" @update:model-value="selectMode">
          <DropdownMenuRadioItem
            v-for="mode in modes"
            :key="mode.value"
            :value="mode.value"
            :disabled="!canEdit || updateAction.loading.value"
          >
            <span class="flex flex-col gap-0.5">
              <span>{{ mode.label }}</span>
              <span class="text-xs text-muted-foreground">{{ mode.description }}</span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { ShieldCheck } from 'lucide-vue-next';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { getSessionPermissions, updateSessionPermissions } from '../api/session.js';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { useAuthStore } from '../stores/auth.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useSessionListStore } from '../stores/session-list.js';

const props = defineProps({
  sessionId: { type: String, default: '' },
  presentation: {
    type: String,
    default: 'dropdown',
    validator: value => ['dropdown', 'submenu'].includes(value),
  },
});

const modes = [
  { value: 'strict', label: '严格', description: '所有风险工具均要求审批。' },
  { value: 'standard', label: '标准', description: '中高风险工具要求审批。' },
  { value: 'relaxed', label: '宽松', description: '仅高风险工具要求审批。' },
  { value: 'dangerously_skip_permissions', label: '跳过审批', description: '自动放行常规风险审批，请谨慎使用。' },
];

const authStore = useAuthStore();
const bootstrapStore = useBootstrapStore();
const sessionListStore = useSessionListStore();
const currentMode = ref('standard');
const currentSession = computed(() => sessionListStore.getById(props.sessionId));
const canEdit = computed(() => bootstrapStore.profile.auth !== 'password'
  || currentSession.value?.user_id === authStore.user?.id);
const modeLabel = computed(() => modes.find(mode => mode.value === currentMode.value)?.label || '标准');
const triggerTitle = computed(() => props.sessionId
  ? `当前会话权限：${modeLabel.value}${canEdit.value ? '' : '（只读）'}`
  : '当前无会话');

const loadAction = useAsyncAction(async () => {
  if (!props.sessionId) return;
  const result = await getSessionPermissions(props.sessionId);
  currentMode.value = result.data?.mode || 'standard';
  if (currentSession.value) currentSession.value.permission_mode = currentMode.value;
}, { errorPrefix: '加载会话权限失败', showErrorToast: false });

const updateAction = useAsyncAction(async mode => {
  if (!props.sessionId || !canEdit.value || mode === currentMode.value) return;
  const result = await updateSessionPermissions(props.sessionId, mode);
  currentMode.value = result.data?.mode || mode;
  if (currentSession.value) currentSession.value.permission_mode = currentMode.value;
}, { successMessage: '会话权限已更新', errorPrefix: '更新会话权限失败' });

function selectMode(mode) {
  void updateAction.run(mode);
}

watch(() => props.sessionId, sessionId => {
  currentMode.value = sessionListStore.getById(sessionId)?.permission_mode || 'standard';
  if (sessionId) void loadAction.run();
}, { immediate: true });
</script>
