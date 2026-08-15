<template>
  <PanelFormShell title="技能" subtitle="管理领域知识与脚本能力注入">
    <div v-for="group in skillGroups" :key="group.key" class="skill-group">
      <div class="skill-group__label">{{ group.title }}</div>
      <p v-if="group.hint" class="skill-group__hint">{{ group.hint }}</p>
      <CheckGrid
        icon="Zap"
        :items="group.items.map((s) => ({ key: s.name, label: s.display_name || s.name, title: s.description || s.name }))"
        :selected="form.skills.enabled_skills"
        @toggle="toggle"
      />
    </div>
    <p v-if="!skillGroups.length" class="panel-empty">暂无可用技能。</p>
  </PanelFormShell>
</template>

<script setup>
import { computed } from 'vue';
import PanelFormShell from './PanelFormShell.vue';
import CheckGrid from './CheckGrid.vue';
import { toggleListItem } from '../../utils/listToggle.js';

const props = defineProps({
  form: { type: Object, required: true },
  skills: { type: Array, default: () => [] },
});

const skillGroups = computed(() => ([
  { key: 'workspace', title: '工作区技能', hint: '入口 Agent 默认可见；其他 Agent 需显式勾选。', items: props.skills.filter((s) => s.source_type === 'workspace') },
  { key: 'user_global', title: '全局技能', hint: '仅在当前 Agent 显式勾选后生效。', items: props.skills.filter((s) => s.source_type === 'user_global') },
  { key: 'builtin', title: '内置技能', hint: '', items: props.skills.filter((s) => s.source_type !== 'workspace' && s.source_type !== 'user_global') },
]).filter((g) => g.items.length > 0));

function toggle(name) {
  toggleListItem(props.form.skills.enabled_skills, name);
}
</script>

<style scoped>
.skill-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: var(--spacing-md); }
.skill-group:last-child { margin-bottom: 0; }
.skill-group__label { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-secondary); }
.skill-group__hint { font-size: var(--font-size-xs); color: var(--color-text-muted); margin: 0; }
</style>
