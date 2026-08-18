<template>
  <section class="panel-form">
    <div class="panel-form__head">
      <h2 class="panel-form__title">{{ title }}</h2>
      <span v-if="subtitle" class="panel-form__sub">{{ subtitle }}</span>
    </div>
    <div class="panel-form__body">
      <slot />
    </div>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
});
</script>

<style>
/* 面板外壳是全局类（非 scoped）：包一层 .studio-panel 限定作用域，让子组件内容也能吃到压实规则，
   各 *Panel 不再各自复制同一份 form-section/section-head 压实 CSS。 */
.studio-panel .panel-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 860px;
}
.studio-panel .panel-form__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--color-border);
}
.studio-panel .panel-form__title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.studio-panel .panel-form__sub {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
.studio-panel .panel-form__body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
.studio-panel .panel-form__body [data-slot='field-group'] {
  gap: var(--spacing-md);
}

/* 开关行：卡片化整行，启用时底色/描边变为 accent 淡色（无左侧竖线） */
.studio-panel .switch-list { display: flex; flex-direction: row; gap: 4px; }
.studio-panel .switch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.studio-panel .switch-row--on {
  background: var(--color-active-bg);
  border-color: transparent;
}
.studio-panel .switch-row--disabled { opacity: 0.5; }
.studio-panel .switch-row__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  transition: color var(--transition-fast);
}
.studio-panel .switch-row--on .switch-row__icon { color: var(--color-brand-accent); }
.studio-panel .switch-row__copy { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.studio-panel .switch-row__label { font-size: var(--font-size-sm); color: var(--color-text-primary); font-weight: 500; }
.studio-panel .switch-row__hint { font-size: var(--font-size-xs); color: var(--color-text-muted); line-height: 1.45; }

/* 只读静态值：与可编辑输入框同边框同底色对齐，但去掉交互感（无 hover/聚焦、光标默认），避免"可编辑却为空"的歧义 */
.studio-panel .form-static {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 34px;
  padding: 0 var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: default;
  user-select: text;
}

.studio-panel .panel-empty { color: var(--color-text-muted); font-size: var(--font-size-sm); margin: 0; }
</style>
