<template>
  <DropdownMenuSub v-if="presentation === 'submenu'">
    <DropdownMenuSubTrigger
      class="data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
      :title="triggerTitle"
    >
      <component :is="modeIcon" :size="14" :class="triggerToneClass" />
      <span class="flex min-w-0 flex-1 items-center justify-between gap-3">
        <span>会话权限</span>
        <span class="text-xs text-muted-foreground">{{ modeLabel }}</span>
      </span>
    </DropdownMenuSubTrigger>
    <DropdownMenuSubContent class="w-72">
      <DropdownMenuGroup>
        <DropdownMenuRadioGroup :model-value="currentMode" @update:model-value="selectMode">
          <DropdownMenuRadioItem
            v-for="mode in modes"
            :key="mode.value"
            :value="mode.value"
            class="permission-option pl-2 gap-2.5"
            :disabled="!canEdit || updateAction.loading.value"
          >
            <component :is="modeIcons[mode.value]" :size="15" class="mode-option-icon" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>{{ mode.label }}</span>
              <span class="text-xs text-muted-foreground">{{ mode.description }}</span>
            </span>
            <IconCheck v-if="currentMode === mode.value" class="check-icon" :size="15" :stroke-width="2.5" />
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </DropdownMenuSubContent>
  </DropdownMenuSub>

  <DropdownMenu v-else>
    <DropdownMenuTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        :class="cn('permission-mode-trigger h-7 w-7', triggerToneClass)"
        :title="triggerTitle"
        :aria-label="triggerTitle"
      >
        <component :is="modeIcon" :size="14" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-72">
      <DropdownMenuGroup>
        <DropdownMenuRadioGroup :model-value="currentMode" @update:model-value="selectMode">
          <DropdownMenuRadioItem
            v-for="mode in modes"
            :key="mode.value"
            :value="mode.value"
            class="permission-option pl-2 gap-2.5"
            :disabled="!canEdit || updateAction.loading.value"
          >
            <component :is="modeIcons[mode.value]" :size="15" class="mode-option-icon" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>{{ mode.label }}</span>
              <span class="text-xs text-muted-foreground">{{ mode.description }}</span>
            </span>
            <IconCheck v-if="currentMode === mode.value" class="check-icon" :size="15" :stroke-width="2.5" />
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-vue-next';
import { Button } from './ui/button';
import { cn } from '@/lib/utils';
import IconCheck from './icons/IconCheck.vue';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { useAsyncAction } from '../composables/useAsyncAction.js';
import { getDefaultPermissionMode, setDefaultPermissionMode } from '../utils/permissionPresentation.js';

const props = defineProps({
  sessionId: { type: String, default: '' },
  chatSdkClient: { type: Object, default: null },
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

const modeIcons = {
  strict: ShieldCheck,
  standard: Shield,
  relaxed: ShieldAlert,
  dangerously_skip_permissions: ShieldOff,
};

const modeToneClasses = {
  strict: 'tone-strict',
  standard: 'tone-standard',
  relaxed: 'tone-relaxed',
  dangerously_skip_permissions: 'tone-skip',
};

const currentMode = ref(getDefaultPermissionMode());
const canEdit = computed(() => true);
const modeLabel = computed(() => modes.find(mode => mode.value === currentMode.value)?.label || '标准');
const modeIcon = computed(() => modeIcons[currentMode.value] || Shield);
const triggerToneClass = computed(() => modeToneClasses[currentMode.value] || 'tone-standard');
const triggerTitle = computed(() => props.sessionId
  ? `当前会话权限：${modeLabel.value}`
  : `新会话默认权限：${modeLabel.value}`);

const loadAction = useAsyncAction(async () => {
  if (!props.sessionId) return;
  if (!props.chatSdkClient) throw new Error('Chat SDK 未初始化');
  const result = await props.chatSdkClient.getSessionPermissions(props.sessionId);
  currentMode.value = result.data?.mode || 'standard';
}, { errorPrefix: '加载会话权限失败', showErrorToast: false });

const updateAction = useAsyncAction(async mode => {
  if (!props.sessionId || !canEdit.value || mode === currentMode.value) return;
  if (!props.chatSdkClient) throw new Error('Chat SDK 未初始化');
  const result = await props.chatSdkClient.updateSessionPermissions(props.sessionId, mode);
  currentMode.value = result.data?.mode || mode;
  setDefaultPermissionMode(currentMode.value);
}, { successMessage: '会话权限已更新', errorPrefix: '更新会话权限失败' });

function selectMode(mode) {
  if (!modes.some(item => item.value === mode)) return;
  if (!props.sessionId) {
    currentMode.value = setDefaultPermissionMode(mode);
    return;
  }
  if (mode === currentMode.value) {
    setDefaultPermissionMode(mode);
    return;
  }
  void updateAction.run(mode);
}

watch(() => props.sessionId, sessionId => {
  currentMode.value = getDefaultPermissionMode();
  if (sessionId) void loadAction.run();
}, { immediate: true });
</script>

<style scoped>
.permission-mode-trigger.tone-strict,
.tone-strict {
  color: var(--color-success);
}

.permission-mode-trigger.tone-standard,
.tone-standard {
  color: var(--color-brand-accent);
}

.permission-mode-trigger.tone-relaxed,
.tone-relaxed {
  color: var(--color-warning);
}

.permission-mode-trigger.tone-skip,
.tone-skip {
  color: var(--color-error);
}

.mode-option-icon {
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.check-icon {
  flex-shrink: 0;
  color: var(--color-success);
}
</style>

<style>
/* DropdownMenuRadioItem 渲染在 Portal（body 下），scoped 样式无法命中；permission-option 类名全局唯一。 */
/* 隐藏默认 radio 圆圈指示器（shadcn 外层 span），选中/高亮样式对齐 LLMSelector / ThinkingLevelSelector。 */
.permission-option > span:first-child {
  display: none;
}

.permission-option[data-state="checked"],
.permission-option[data-highlighted] {
  background: var(--color-interactive-hover);
}
</style>
