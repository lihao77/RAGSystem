<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="runtime-capsule"
        :class="{ 'is-active': hasActivity, 'is-open': open }"
        :style="hasActivity ? { '--tone': aggregateColor } : undefined"
        :title="triggerTitle"
        aria-label="打开运行概览"
        :aria-expanded="open ? 'true' : 'false'"
      >
        <span
          v-if="hasActivity"
          class="runtime-capsule__dot"
          :class="{ 'is-live': aggregateTone === 'running' }"
          aria-hidden="true"
        />
        <Activity v-else aria-hidden="true" />
        <span class="runtime-capsule__summary">{{ summaryText || '运行' }}</span>
      </button>
    </PopoverTrigger>

    <PopoverContent
      align="end"
      side="bottom"
      :side-offset="10"
      class="runtime-capsule-popover w-[min(94vw,640px)] overflow-hidden p-0"
    >
      <header class="capsule-head">
        <span class="capsule-head__title">运行概览</span>
        <span class="capsule-head__summary">{{ summaryText || '无运行中活动' }}</span>
      </header>

      <div class="capsule-columns">
        <section class="capsule-agents" aria-label="智能体">
          <header class="capsule-agents__head">
            <span class="capsule-label">智能体</span>
            <span class="capsule-agents__count">{{ orderedParticipants.length }}</span>
          </header>
          <ul v-if="orderedParticipants.length" class="capsule-agents__list">
            <li v-for="participant in orderedParticipants" :key="participant.participant_id">
              <button
                type="button"
                class="capsule-agent"
                :class="{ 'is-selected': participant.participant_id === selectedParticipantId }"
                :style="{ '--participant-accent': participantAccentColor(participant) }"
                :aria-current="participant.participant_id === selectedParticipantId ? 'true' : undefined"
                @click="selectParticipant(participant.participant_id)"
              >
                <span class="capsule-agent__avatar" aria-hidden="true">
                  <Bot v-if="participant.scope === 'root'" />
                  <GitBranch v-else />
                </span>
                <span class="capsule-agent__main">
                  <span class="capsule-agent__name">{{ participantName(participant) }}</span>
                  <span class="capsule-agent__meta">{{ participantMeta(participant) }}</span>
                </span>
                <span class="capsule-agent__status">
                  <span v-if="agentStatusText(participant)" class="capsule-agent__status-text">
                    {{ agentStatusText(participant) }}
                  </span>
                  <span
                    class="capsule-dot"
                    :class="{ 'is-live': isLiveParticipant(participant) }"
                    :style="{ '--dot-color': statusToneColor(participantStatus(participant)) }"
                    :title="statusLabel(participantStatus(participant))"
                  />
                </span>
              </button>
            </li>
          </ul>
          <p v-else class="capsule-agents__empty">暂无参与者</p>
        </section>

        <div class="capsule-runtime">
          <RuntimeOverviewPanel :task-state="taskState" :goal-state="goalState" />
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup>
import { computed, ref } from 'vue';
import { Activity, Bot, GitBranch } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import RuntimeOverviewPanel from '../workpanel/RuntimeOverviewPanel.vue';
import {
  participantAccentColor,
  statusLabel,
  statusToneColor,
} from '@/utils/participantVisual.js';

// 运行中只有脉冲点,不亮文字;文字留给需要被看见的异常状态。
const ERROR_STATUSES = new Set(['failed', 'interrupted']);
const TEXT_STATUSES = new Set(['failed', 'interrupted', 'cancelled', 'suspended', 'blocked']);

const props = defineProps({
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
  participants: { type: Array, default: () => [] },
  selectedParticipantId: { type: String, default: 'root' },
  approvals: { type: Array, default: () => [] },
});

const emit = defineEmits(['select-participant']);

const open = ref(false);

// root 在前,与原会话智能体侧栏同一顺序。
const orderedParticipants = computed(() => {
  const items = props.participants.filter(item => item?.participant_id);
  const root = items.find(item => item.scope === 'root') || items.find(item => item.participant_id === 'root');
  const rest = items.filter(item => item !== root);
  return root ? [root, ...rest] : rest;
});

const participantStatus = (participant) => participant.last_run_status || participant.lifecycle_status;
const isLiveParticipant = (participant) => participantStatus(participant) === 'running';
const participantName = (participant) => (
  participant.display_name || participant.agent_name || (participant.scope === 'root' ? '主智能体' : '智能体')
);
const participantMeta = (participant) => (
  participant.scope === 'root' ? '主智能体' : (participant.agent_name || '子智能体')
);
const agentStatusText = (participant) => {
  const status = participantStatus(participant);
  return TEXT_STATUSES.has(status) ? statusLabel(status) : '';
};

// 聚合状态优先级:待审批 > 异常(失败/阻塞) > 运行中 > 静默。
// 审批需要用户动作,必须压倒一切运行态。
const aggregateTone = computed(() => {
  if (props.approvals.length) return 'suspended';
  const hasErrorTask = (props.taskState.tasks || []).some(task => ERROR_STATUSES.has(task.status));
  const goalStatus = props.goalState.goal?.status;
  if (hasErrorTask || goalStatus === 'blocked' || goalStatus === 'failed') return 'failed';
  if (props.taskState.runningCount) return 'running';
  if (orderedParticipants.value.some(isLiveParticipant)) return 'running';
  if (goalStatus === 'active') return 'running';
  return 'pending';
});
const aggregateColor = computed(() => statusToneColor(aggregateTone.value));

const hasActivity = computed(() => Boolean(
  props.approvals.length
  || props.taskState.tasks?.length
  || props.goalState.goal
  || props.participants.length > 1,
));

const summaryText = computed(() => {
  if (!hasActivity.value) return '';
  const parts = [];
  if (props.approvals.length) parts.push(`${props.approvals.length} 待审批`);
  if (props.taskState.runningCount) parts.push(`${props.taskState.runningCount} 任务`);
  if (props.participants.length > 1) parts.push(`${props.participants.length} 智能体`);
  if (!parts.length && props.goalState.goal) parts.push(`Goal ${statusLabel(props.goalState.goal.status)}`);
  return parts.slice(0, 3).join(' · ');
});

const triggerTitle = computed(() => {
  const details = [];
  if (props.approvals.length) details.push(`${props.approvals.length} 项待审批`);
  if (props.taskState.runningCount) details.push(`${props.taskState.runningCount} 个后台任务运行中`);
  if (props.goalState.goal) details.push(`Goal ${statusLabel(props.goalState.goal.status)}`);
  return details.length ? `运行概览：${details.join('，')}` : '运行概览';
});

const selectParticipant = (participantId) => {
  emit('select-participant', participantId);
  open.value = false;
};
</script>

<style scoped>
/* ===== 触发器:状态调色的玻璃胶囊 =====
   --tone 承载聚合状态色(内联注入),激活态整体染色而不只是圆点。 */
.runtime-capsule {
  display: inline-flex;
  min-width: 0;
  max-width: 240px;
  height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 11px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-default),
    border-color var(--duration-fast) var(--ease-default),
    box-shadow var(--duration-fast) var(--ease-default),
    color var(--duration-fast) var(--ease-default);
}

.runtime-capsule:hover,
.runtime-capsule.is-open {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.runtime-capsule.is-active {
  border-color: color-mix(in srgb, var(--tone) 28%, transparent);
  background: color-mix(in srgb, var(--tone) 9%, transparent);
  box-shadow: var(--shadow-xs);
  color: var(--color-text-primary);
}

.runtime-capsule.is-active:hover,
.runtime-capsule.is-active.is-open {
  background: color-mix(in srgb, var(--tone) 14%, transparent);
  box-shadow: var(--shadow-sm);
}

.runtime-capsule svg {
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.runtime-capsule__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--tone, var(--color-text-muted));
}

.runtime-capsule__dot.is-live {
  animation: capsule-dot-pulse 1.6s var(--ease-default) infinite;
}

.runtime-capsule__summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ===== 弹层骨架:头部 + 通栏审批 + 左右双栏 ===== */
.runtime-capsule-popover {
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-elevated);
}

.capsule-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 16px 10px;
  border-bottom: 1px solid var(--color-border);
}

.capsule-head__title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 650;
  letter-spacing: 0.01em;
}

.capsule-head__summary {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capsule-label {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.capsule-columns {
  display: flex;
  max-height: min(72vh, 540px);
  min-height: 0;
  align-items: stretch;
}

/* ===== 左栏:智能体导航 ===== */
.capsule-agents {
  display: flex;
  width: 216px;
  min-height: 0;
  flex: 0 0 216px;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-hover-overlay);
}

.capsule-agents__head {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 8px;
}

.capsule-agents__count {
  min-width: 20px;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--color-hover-overlay-md);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.5;
  text-align: center;
}

.capsule-agents__list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  padding: 0 8px 12px;
}

.capsule-agent {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 9px;
  padding: 7px 9px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-default),
    box-shadow var(--duration-fast) var(--ease-default);
}

.capsule-agent:hover {
  background: var(--color-hover-overlay-md);
}

.capsule-agent.is-selected {
  background: color-mix(in srgb, var(--participant-accent) 11%, transparent);
}

.capsule-agent__avatar {
  display: inline-flex;
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--participant-accent) 14%, transparent);
  color: var(--participant-accent, var(--color-text-muted));
}

.capsule-agent__avatar svg {
  width: 13px;
  height: 13px;
}

.capsule-agent__main {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.capsule-agent__name {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: 550;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capsule-agent__meta {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.capsule-agent__status {
  display: inline-flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.capsule-agent__status-text {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1;
}

.capsule-agents__empty {
  padding: 16px 14px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.capsule-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}

.capsule-dot.is-live {
  animation: capsule-dot-pulse 1.6s var(--ease-default) infinite;
}

/* ===== 右栏:Goal + 后台任务 ===== */
.capsule-runtime {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
}

@keyframes capsule-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dot-color, var(--tone, transparent)) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}

/* 窄屏退化为单栏:智能体在上(限高滚动),任务/Goal 在下 */
@media (max-width: 620px) {
  .capsule-columns {
    flex-direction: column;
    max-height: min(76vh, 560px);
    overflow-y: auto;
  }

  .capsule-agents {
    width: 100%;
    flex: 0 0 auto;
    border-right: none;
    border-bottom: 1px solid var(--color-border);
  }

  .capsule-agents__list {
    max-height: 172px;
    flex: 0 0 auto;
  }

  .capsule-runtime {
    overflow: visible;
  }
}

@media (max-width: 480px) {
  .runtime-capsule {
    max-width: none;
    padding: 0 8px;
  }

  .runtime-capsule__summary {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .runtime-capsule__dot.is-live,
  .capsule-dot.is-live {
    animation: none;
  }
}
</style>
