<template>
  <component
    :is="variant === 'static' ? 'div' : 'button'"
    :type="variant === 'static' ? null : 'button'"
    class="wb-nav-row"
    :class="{
      'wb-nav-row--active': active,
      'wb-nav-row--static': variant === 'static',
      'wb-nav-row--add': variant === 'add',
    }"
    :disabled="variant === 'static' ? null : disabled"
    @click="emit('click', $event)"
  >
    <template v-if="variant === 'add'">
      <slot />
    </template>
    <template v-else>
      <span class="wb-nav-row__title">
        <span class="wb-nav-row__name">{{ title }}</span>
        <slot name="title-trailing" />
      </span>
      <span v-if="description || $slots.default" class="wb-nav-row__desc">
        <slot>{{ description }}</slot>
      </span>
      <span v-if="$slots.meta" class="wb-nav-row__meta">
        <slot name="meta" />
      </span>
    </template>
  </component>
</template>

<script setup>
// 管理页左栏导航行：样式见 styles/admin-workbench.css（.wb-nav-row）
defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  active: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  variant: {
    type: String,
    default: 'default',
    validator: (v) => ['default', 'static', 'add'].includes(v),
  },
});

const emit = defineEmits(['click']);
</script>
