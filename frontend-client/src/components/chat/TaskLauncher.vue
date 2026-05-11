<template>
  <section class="task-launcher">
    <!-- Ambient glow -->
    <div class="task-launcher__glow" aria-hidden="true"></div>

    <div class="task-launcher__hero">
      <IconLogo :size="44" class="task-launcher__logo" />
      <h1 class="task-launcher__title">What can I help&nbsp;with?</h1>
    </div>

    <div class="task-launcher__cards">
      <button
        v-for="t in templates"
        :key="t.id"
        type="button"
        class="prompt-card"
        @click="emit('selectTemplate', t.prompt)"
      >
        <span class="prompt-card__title">{{ t.title }}</span>
        <span class="prompt-card__desc">{{ t.desc }}</span>
      </button>
    </div>

    <div class="task-launcher__config">
      <label class="cfg">
        <span class="cfg__label">Agent</span>
        <CustomSelect
          :model-value="entryAgent"
          :options="entryAgentOptions"
          :disabled="entryAgentLoading"
          :dropdown-max-height="320"
          dropdown-placement="auto"
          placeholder="Default"
          @update:modelValue="emit('update:entryAgent', $event)"
        />
      </label>
      <label class="cfg cfg--grow">
        <span class="cfg__label">Path</span>
        <input
          :value="workspaceRoot"
          type="text"
          placeholder="Optional workspace path"
          autocomplete="off"
          spellcheck="false"
          @input="emit('update:workspaceRoot', $event.target.value)"
          @blur="emit('update:workspaceRoot', normalizeWorkspaceRootInput($event.target.value))"
        />
      </label>
    </div>
  </section>
</template>

<script setup>
import { IconLogo } from '../icons';
import CustomSelect from '../CustomSelect.vue';

defineProps({
  entryAgent: { type: String, default: '' },
  entryAgentOptions: { type: Array, default: () => [] },
  entryAgentLoading: { type: Boolean, default: false },
  workspaceRoot: { type: String, default: '' },
  normalizeWorkspaceRootInput: { type: Function, required: true },
});

const emit = defineEmits([
  'update:entryAgent',
  'update:workspaceRoot',
  'selectTemplate',
]);

const templates = [
  {
    id: 'repo-map',
    title: 'Explore repo',
    desc: 'Scan structure, modules & data flow',
    prompt: '请梳理当前工作区的仓库结构，说明主要模块、入口文件、关键数据流和后续建议。',
  },
  {
    id: 'fix-tests',
    title: 'Fix tests',
    desc: 'Locate failures & apply minimal fix',
    prompt: '请运行相关测试，定位失败原因，并做最小必要修复。完成后说明改动和验证结果。',
  },
  {
    id: 'implement-feature',
    title: 'Build feature',
    desc: 'Implement with existing patterns',
    prompt: '请先阅读相关代码，按现有架构实现这个功能，并补充必要验证：',
  },
  {
    id: 'code-review',
    title: 'Code review',
    desc: 'Audit changes, flag risks & gaps',
    prompt: '请对当前改动做代码审查，优先指出 bug、行为回归、风险和缺失测试，并给出文件位置。',
  },
];
</script>

<style scoped>
/* ── Container ─────────────────────────────────── */
.task-launcher {
  position: relative;
  width: min(620px, 100%);
  margin: 0 auto;
  padding: clamp(48px, 14vh, 140px) 0 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 36px;
}

/* ── Ambient glow ──────────────────────────────── */
.task-launcher__glow {
  position: absolute;
  top: clamp(20px, 8vh, 80px);
  left: 50%;
  transform: translateX(-50%);
  width: 400px;
  height: 200px;
  border-radius: 50%;
  background: radial-gradient(
    ellipse at center,
    rgba(var(--color-brand-accent-rgb), 0.08) 0%,
    transparent 70%
  );
  pointer-events: none;
  filter: blur(40px);
}

/* ── Hero ──────────────────────────────────────── */
.task-launcher__hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  position: relative;
  z-index: 1;
}

.task-launcher__logo {
  opacity: 0.65;
  filter: drop-shadow(0 0 20px rgba(var(--color-brand-accent-rgb), 0.15));
}

.task-launcher__title {
  margin: 0;
  font-size: clamp(28px, 3.6vw, 38px);
  font-weight: 680;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: var(--color-text-primary);
  text-align: center;
}

/* ── Prompt cards — 2×2 grid ───────────────────── */
.task-launcher__cards {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  position: relative;
  z-index: 1;
}

.prompt-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 18px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: rgba(var(--color-bg-elevated-rgb), 0.35);
  text-align: left;
  cursor: pointer;
  transition:
    background 0.22s ease,
    border-color 0.22s ease,
    box-shadow 0.22s ease,
    transform 0.22s ease;
}

.prompt-card:hover {
  background: rgba(var(--color-bg-elevated-rgb), 0.65);
  border-color: var(--color-border-hover);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15);
  transform: translateY(-1px);
}

.prompt-card__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.prompt-card__desc {
  font-size: 12px;
  font-weight: 450;
  color: var(--color-text-muted);
  line-height: 1.4;
}

/* ── Config row ────────────────────────────────── */
.task-launcher__config {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: rgba(var(--color-bg-elevated-rgb), 0.2);
  transition:
    background 0.25s ease,
    border-color 0.25s ease;
  position: relative;
  z-index: 1;
}

.task-launcher__config:hover,
.task-launcher__config:focus-within {
  background: rgba(var(--color-bg-elevated-rgb), 0.4);
  border-color: var(--color-border);
}

.cfg {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cfg--grow {
  flex: 1;
}

.cfg__label {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.cfg input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.cfg input::placeholder {
  color: var(--color-text-muted);
  font-size: 12px;
}

.cfg input:focus {
  outline: none;
  background: rgba(var(--color-bg-elevated-rgb), 0.5);
}

.cfg :deep(.select-trigger) {
  height: 28px;
  min-width: 90px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  padding: 0 24px 0 8px;
}

.cfg :deep(.arrow-icon) {
  right: 6px;
}

.cfg :deep(.select-trigger:hover) {
  background: rgba(var(--color-bg-elevated-rgb), 0.5);
}

/* ── Mobile ────────────────────────────────────── */
@media (max-width: 767px) {
  .task-launcher {
    padding: 36px 0 160px;
    gap: 28px;
  }

  .task-launcher__glow {
    width: 280px;
    height: 140px;
  }

  .task-launcher__title {
    font-size: 26px;
  }

  .task-launcher__cards {
    grid-template-columns: 1fr;
  }

  .task-launcher__config {
    flex-wrap: wrap;
  }
}
</style>
