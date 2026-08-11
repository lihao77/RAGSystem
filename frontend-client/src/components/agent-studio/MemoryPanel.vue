<template>
  <PanelFormShell title="记忆" subtitle="记忆索引注入与 scope 权限；scope 定位由运行时推导">
    <div class="switch-list">
      <SwitchRow label="启用记忆插件" :checked="form.memory.enabled" @update:checked="form.memory.enabled = $event" />
      <SwitchRow v-if="form.memory.enabled" label="自动注入记忆索引" :checked="form.memory.auto_inject" @update:checked="form.memory.auto_inject = $event" />
    </div>

    <template v-if="form.memory.enabled">
      <div class="scope-title">Scope 权限</div>
      <div class="scope-grid">
        <div v-for="scope in scopeMeta" :key="scope.name" class="scope-card">
          <div class="scope-card__head">
            <span class="scope-card__name">{{ scope.name }}</span>
            <span class="scope-card__desc">{{ scope.description }}</span>
          </div>
          <div class="scope-card__perms">
            <label class="scope-perm">
              <input :checked="form.memory.allowed_scopes.includes(scope.name)" type="checkbox" @change="toggleScope('allowed_scopes', scope.name, $event.target.checked)" />
              <span>读取</span>
            </label>
            <label class="scope-perm">
              <input :checked="form.memory.write_scopes.includes(scope.name)" type="checkbox" @change="toggleScope('write_scopes', scope.name, $event.target.checked)" />
              <span>写入</span>
            </label>
            <label class="scope-perm">
              <input :checked="form.memory.archive_scopes.includes(scope.name)" type="checkbox" @change="toggleScope('archive_scopes', scope.name, $event.target.checked)" />
              <span>归档</span>
            </label>
          </div>
        </div>
      </div>
    </template>
  </PanelFormShell>
</template>

<script setup>
import PanelFormShell from './PanelFormShell.vue';
import SwitchRow from './SwitchRow.vue';

const props = defineProps({
  form: { type: Object, required: true },
  scopeMeta: { type: Array, default: () => [] },
});

function toggleScope(field, scope, checked) {
  const mem = props.form.memory;
  const list = mem[field];
  const i = list.indexOf(scope);
  if (checked && i < 0) list.push(scope);
  else if (!checked && i >= 0) list.splice(i, 1);
  if (field === 'allowed_scopes' && !checked) {
    mem.write_scopes = mem.write_scopes.filter((s) => s !== scope);
    mem.archive_scopes = mem.archive_scopes.filter((s) => s !== scope);
  }
  if ((field === 'write_scopes' || field === 'archive_scopes') && checked && !mem.allowed_scopes.includes(scope)) {
    mem.allowed_scopes.push(scope);
  }
}
</script>

<style scoped>
.scope-title { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-secondary); margin-bottom: 8px; }
.scope-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--spacing-sm); }
.scope-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: transparent; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.scope-card__head { display: flex; flex-direction: column; gap: 3px; }
.scope-card__name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); }
.scope-card__desc { font-size: var(--font-size-xs); color: var(--color-text-muted); line-height: 1.45; }
.scope-card__perms { display: flex; flex-wrap: wrap; gap: 8px; }
.scope-perm { display: inline-flex; align-items: center; gap: 6px; font-size: var(--font-size-xs); color: var(--color-text-secondary); cursor: pointer; }
.scope-perm input { accent-color: var(--color-brand-accent); width: 14px; height: 14px; cursor: pointer; }
</style>
