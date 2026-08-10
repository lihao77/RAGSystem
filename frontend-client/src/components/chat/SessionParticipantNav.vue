<template>
  <aside v-if="mode === 'desktop'" class="participant-rail" aria-label="会话智能体">
    <div class="participant-rail__list" role="list">
      <template v-if="loading && !railItems.length">
        <Skeleton v-for="index in 3" :key="index" class="participant-rail__skeleton" />
      </template>
      <TooltipProvider v-else :delay-duration="120">
        <Tooltip v-for="{ participant } in railItems" :key="participant.participant_id">
          <TooltipTrigger as-child>
            <button
              type="button"
              role="listitem"
              class="participant-rail__item"
              :class="{ 'is-selected': participant.participant_id === selectedId }"
              :style="{ '--participant-accent': participantAccentColor(participant) }"
              :aria-label="`${participantName(participant)} · ${statusText(participant)}`"
              :aria-current="participant.participant_id === selectedId ? 'true' : undefined"
              @click="emit('select', participant.participant_id)"
            >
              <span class="participant-rail__icon">
                <Bot v-if="participant.scope === 'root'" />
                <GitBranch v-else />
              </span>
              <span
                class="participant-rail__dot"
                :class="{ 'is-live': isLive(participant) }"
                :style="{ '--dot-color': statusToneColor(participantStatus(participant)) }"
                aria-hidden="true"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" class="participant-rail__tip">
            <p class="participant-rail__tip-name">{{ participantName(participant) }}</p>
            <p class="participant-rail__tip-meta">{{ participantMeta(participant) }} · {{ statusText(participant) }}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>

    <TooltipProvider :delay-duration="120">
      <Tooltip>
        <TooltipTrigger as-child>
          <button
            type="button"
            class="participant-rail__refresh"
            :disabled="loading"
            aria-label="刷新智能体"
            @click="emit('refresh')"
          >
            <RefreshCw :class="{ 'participant-rail__spin': loading }" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">刷新智能体</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </aside>

  <div v-else class="participant-nav-mobile">
    <Sheet v-model:open="mobileOpen">
      <SheetTrigger as-child>
        <Button variant="ghost" size="sm" class="participant-nav-mobile__trigger">
          <Bot data-icon="inline-start" />
          <span class="truncate">{{ selectedParticipant?.display_name || '智能体' }}</span>
          <Badge v-if="participants.length > 1" variant="secondary">{{ participants.length }}</Badge>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" class="participant-nav-sheet">
        <SheetHeader>
          <SheetTitle>会话智能体</SheetTitle>
          <SheetDescription>{{ participants.length }} 个参与者</SheetDescription>
        </SheetHeader>
        <div class="participant-sheet-list">
          <button
            v-for="{ participant } in railItems"
            :key="participant.participant_id"
            type="button"
            class="participant-sheet-list__item"
            :class="{ 'is-selected': participant.participant_id === selectedId }"
            :style="{ '--participant-accent': participantAccentColor(participant) }"
            @click="selectFromSheet(participant.participant_id)"
          >
            <span class="participant-sheet-list__icon">
              <Bot v-if="participant.scope === 'root'" />
              <GitBranch v-else />
            </span>
            <span class="participant-sheet-list__identity">
              <span class="participant-sheet-list__name">{{ participantName(participant) }}</span>
              <span class="participant-sheet-list__meta">{{ participantMeta(participant) }}</span>
            </span>
            <span
              class="participant-sheet-list__dot"
              :style="{ '--dot-color': statusToneColor(participantStatus(participant)) }"
              :title="statusText(participant)"
            />
          </button>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Bot, ChevronDown, GitBranch, RefreshCw } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  participantAccentColor,
  statusLabel,
  statusToneColor,
} from '@/utils/participantVisual.js';

const props = defineProps({
  mode: { type: String, default: 'desktop' },
  participants: { type: Array, default: () => [] },
  selectedId: { type: String, default: 'root' },
  loading: { type: Boolean, default: false },
});
const emit = defineEmits(['select', 'refresh']);
const mobileOpen = ref(false);

const selectedParticipant = computed(() => props.participants.find(
  item => item?.participant_id === props.selectedId,
) || null);

// root 在前,其余按父级就近排序;窄栏只关心顺序,不再表达缩进层级。
const railItems = computed(() => {
  const items = props.participants.filter(item => item?.participant_id);
  const root = items.find(item => item.scope === 'root') || items.find(item => item.participant_id === 'root');
  const rest = items.filter(item => item !== root);
  const ordered = root ? [root, ...rest] : rest;
  return ordered.map(participant => ({ participant }));
});

const participantStatus = (participant) => participant.last_run_status || participant.lifecycle_status;
const statusText = (participant) => statusLabel(participantStatus(participant));
const isLive = (participant) => participantStatus(participant) === 'running';

const participantName = (participant) => (
  participant.display_name || participant.agent_name || (participant.scope === 'root' ? '主智能体' : '智能体')
);
const participantMeta = (participant) => (
  participant.scope === 'root' ? '主智能体' : (participant.agent_name || '子智能体')
);

const selectFromSheet = (participantId) => {
  emit('select', participantId);
  mobileOpen.value = false;
};
</script>

<style scoped>
/* 窄竖向图标栏:退到对话之后的安静陪衬 */
.participant-rail {
  width: 56px;
  flex: 0 0 56px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 0;
  border-right: 1px solid var(--color-border);
  background: var(--surface-rail);
}

.participant-rail__list {
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 100%;
  scrollbar-width: none;
}

.participant-rail__list::-webkit-scrollbar {
  display: none;
}

.participant-rail__item {
  position: relative;
  display: inline-flex;
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--participant-accent, var(--color-text-secondary));
  cursor: pointer;
  transition: background var(--transition-fast), transform var(--transition-fast);
}

.participant-rail__item:hover {
  background: var(--color-hover-overlay);
}

.participant-rail__item:active {
  transform: scale(0.94);
}

.participant-rail__item.is-selected {
  background: var(--color-active-bg);
}

.participant-rail__item.is-selected::before {
  content: '';
  position: absolute;
  left: -9px;
  top: 50%;
  width: 3px;
  height: 18px;
  border-radius: var(--radius-full);
  background: var(--participant-accent, var(--color-brand-accent));
  transform: translateY(-50%);
}

.participant-rail__icon {
  display: inline-flex;
  width: 19px;
  height: 19px;
}

.participant-rail__icon svg {
  width: 100%;
  height: 100%;
}

.participant-rail__dot {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 9px;
  height: 9px;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
  border: 2px solid var(--surface-rail);
}

.participant-rail__dot.is-live {
  animation: participant-dot-pulse 1.4s ease-in-out infinite;
}

.participant-rail__refresh {
  display: inline-flex;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0.7;
  transition: background var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast);
}

.participant-rail__refresh:hover:not(:disabled) {
  background: var(--color-hover-overlay);
  color: var(--color-text-secondary);
  opacity: 1;
}

.participant-rail__refresh:disabled {
  cursor: default;
}

.participant-rail__refresh svg {
  width: 16px;
  height: 16px;
}

.participant-rail__skeleton {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-lg);
}

.participant-rail__spin {
  animation: participant-spin 900ms linear infinite;
}

.participant-rail__tip-name {
  font-weight: 600;
}

.participant-rail__tip-meta {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

/* 移动端 Sheet 列表:与窄栏同套色点/着色,瘦身单行 */
.participant-nav-mobile {
  display: none;
  min-width: 0;
  padding: 4px 10px;
  border-bottom: 1px solid var(--color-border);
}

.participant-nav-mobile__trigger {
  max-width: 100%;
  min-width: 0;
}

.participant-sheet-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 12px;
}

.participant-sheet-list__item {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.participant-sheet-list__item:hover {
  background: var(--color-hover-overlay);
}

.participant-sheet-list__item.is-selected {
  background: var(--color-active-bg);
}

.participant-sheet-list__icon {
  display: inline-flex;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  color: var(--participant-accent, var(--color-text-secondary));
}

.participant-sheet-list__icon svg {
  width: 100%;
  height: 100%;
}

.participant-sheet-list__identity {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.participant-sheet-list__name,
.participant-sheet-list__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.participant-sheet-list__name {
  font-size: var(--font-size-sm);
}

.participant-sheet-list__meta {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.participant-sheet-list__dot {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}

@keyframes participant-spin {
  to { transform: rotate(360deg); }
}

@keyframes participant-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--color-accent-rgb), 0.35); }
  50% { box-shadow: 0 0 0 3px rgba(var(--color-accent-rgb), 0); }
}

@media (max-width: 1023px) {
  .participant-rail {
    display: none;
  }

  .participant-nav-mobile {
    display: block;
  }
}

@media (prefers-reduced-motion: reduce) {
  .participant-rail__dot.is-live {
    animation: none;
  }
}
</style>
