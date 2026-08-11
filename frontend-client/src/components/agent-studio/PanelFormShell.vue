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
  gap: var(--spacing-md);
  max-width: 860px;
}
.studio-panel .panel-form__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.studio-panel .panel-form__title {
  margin: 0;
  color: var(--color-text-secondary);
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

/* 开关行：label + hint 左、开关右 */
.studio-panel .switch-list { display: flex; flex-direction: column; gap: 2px; }
.studio-panel .switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: 6px 0;
}
.studio-panel .switch-row__copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
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
