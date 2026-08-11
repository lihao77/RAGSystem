<template>
  <div class="panel-form"><section class="form-section">
    <div class="section-head"><h4>记忆</h4><span>记忆索引注入与 scope 权限；scope 定位由运行时推导</span></div>
    <div class="section-body">
      <div class="switch-list">
        <div class="switch-row">
          <span class="switch-row__label">启用记忆插件</span>
          <Switch v-model:checked="form.memory.enabled" />
        </div>
        <div v-if="form.memory.enabled" class="switch-row">
          <span class="switch-row__label">自动注入记忆索引</span>
          <Switch v-model:checked="form.memory.auto_inject" />
        </div>
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
    </div>
  </section></div>
</template>

<script setup>
import { Switch } from '../ui/switch';

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
.form-section { gap: var(--spacing-sm); padding: 0; }
.section-head { padding-bottom: var(--spacing-sm); margin-bottom: 0; border-bottom: 1px solid var(--color-border); }
.section-head h2, .section-head h4 { font-size: var(--font-size-md); }
.section-body { gap: var(--spacing-md); }
.switch-list { display: flex; flex-direction: column; gap: 2px; }
.switch-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: 8px 0; }
.switch-row__label { font-size: var(--font-size-sm); color: var(--color-text-primary); font-weight: 500; }
.scope-title { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-secondary); margin-bottom: 8px; }
.scope-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--spacing-sm); }
.scope-card { border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-elevated); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.scope-card__head { display: flex; flex-direction: column; gap: 3px; }
.scope-card__name { font-size: var(--font-size-sm); font-weight: 600; color: var(--color-text-primary); }
.scope-card__desc { font-size: var(--font-size-xs); color: var(--color-text-muted); line-height: 1.45; }
.scope-card__perms { display: flex; flex-wrap: wrap; gap: 8px; }
.scope-perm { display: inline-flex; align-items: center; gap: 6px; font-size: var(--font-size-xs); color: var(--color-text-secondary); cursor: pointer; }
.scope-perm input { accent-color: var(--color-brand-accent); width: 14px; height: 14px; cursor: pointer; }
</style>
