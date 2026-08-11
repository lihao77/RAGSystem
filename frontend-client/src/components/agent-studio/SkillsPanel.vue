<template>
  <div class="panel-form"><section class="form-section">
    <div class="section-head"><h2>技能</h2><span>管理领域知识与脚本能力注入</span></div>
    <div class="section-body">
      <div v-for="group in skillGroups" :key="group.key" class="skill-group">
        <div class="skill-group__label">{{ group.title }}</div>
        <p v-if="group.hint" class="skill-group__hint">{{ group.hint }}</p>
        <div class="check-grid">
          <label
            v-for="skill in group.items"
            :key="`${group.key}-${skill.name}`"
            class="check-item"
            :title="skill.description || skill.name"
          >
            <input
              type="checkbox"
              :checked="form.skills.enabled_skills.includes(skill.name)"
              @change="toggle(skill.name)"
            />
            <span class="check-item__text">{{ skill.display_name || skill.name }}</span>
          </label>
        </div>
      </div>
      <p v-if="!skillGroups.length" class="form-empty">暂无可用技能。</p>
    </div>
  </section></div>
</template>

<script setup>
import { computed } from 'vue';

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
  const list = props.form.skills.enabled_skills;
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
}
</script>

<style scoped>
.form-section { gap: var(--spacing-sm); padding: 0; }
.section-head { padding-bottom: var(--spacing-sm); margin-bottom: 0; border-bottom: 1px solid var(--color-border); }
.section-head h2, .section-head h4 { font-size: var(--font-size-md); }
.section-body { gap: var(--spacing-md); }
.skill-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: var(--spacing-md); }
.skill-group:last-child { margin-bottom: 0; }
.skill-group__label { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-secondary); }
.skill-group__hint { font-size: var(--font-size-xs); color: var(--color-text-muted); margin: 0; }
.form-empty { color: var(--color-text-muted); font-size: var(--font-size-sm); margin: 0; }
</style>
