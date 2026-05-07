<template>
  <div class="schema-form">
    <section
      v-for="group in schema.groups"
      :key="group.key"
      :id="`sf-${group.key}`"
      class="form-section"
    >
      <div class="section-head" :class="{ 'section-head--clickable': collapsibleGroups }" @click="collapsibleGroups && toggleGroup(group.key)">
        <h2>
          {{ group.label }}
          <svg v-if="collapsibleGroups" class="collapse-icon" :class="{ 'collapse-icon--open': !collapsed[group.key] }"
               xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
               fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </h2>
        <span v-if="group.description">{{ group.description }}</span>
      </div>

      <div v-show="!collapsed[group.key]" class="section-body form-grid">
        <template v-for="field in group.fields" :key="field.key">
          <!-- boolean → switch -->
          <label v-if="field.type === 'boolean'" class="form-item switch-item">
            <span class="field-label-text">{{ field.label }}</span>
            <span class="switch-control">
              <input
                type="checkbox"
                :checked="getFieldValue(group.key, field.key)"
                :disabled="disabled"
                @change="setFieldValue(group.key, field.key, $event.target.checked)"
              />
              <span class="switch-control__track"><span class="switch-control__thumb"></span></span>
            </span>
          </label>

          <!-- select → CustomSelect -->
          <label v-else-if="field.type === 'select'" class="form-item">
            <span class="field-label-text">{{ field.label }}</span>
            <CustomSelect
              :model-value="String(getFieldValue(group.key, field.key) ?? '')"
              :options="field.options || []"
              :disabled="disabled"
              @update:model-value="setFieldValue(group.key, field.key, $event, field)"
            />
            <small v-if="field.help" class="field-hint">{{ field.help }}</small>
          </label>

          <!-- number → NumberInput -->
          <label v-else-if="field.type === 'number'" class="form-item">
            <span class="field-label-text">{{ field.label }}</span>
            <NumberInput
              :model-value="getFieldValue(group.key, field.key) ?? field.default ?? 0"
              :min="field.min ?? -Infinity"
              :max="field.max ?? Infinity"
              :step="field.step ?? 1"
              :disabled="disabled"
              @update:model-value="setFieldValue(group.key, field.key, $event)"
            />
            <small v-if="field.help" class="field-hint">{{ field.help }}</small>
          </label>

          <!-- textarea -->
          <label v-else-if="field.type === 'textarea'" class="form-item" style="grid-column: 1 / -1">
            <span class="field-label-text">{{ field.label }}</span>
            <textarea
              class="form-control form-control--textarea"
              rows="4"
              :value="getFieldValue(group.key, field.key) ?? ''"
              :disabled="disabled"
              :placeholder="field.placeholder || ''"
              @input="setFieldValue(group.key, field.key, $event.target.value)"
            />
            <small v-if="field.help" class="field-hint">{{ field.help }}</small>
          </label>

          <!-- text / password (default) -->
          <label v-else class="form-item">
            <span class="field-label-text">{{ field.label }}</span>
            <input
              class="form-control"
              :type="field.type === 'password' ? 'password' : 'text'"
              :value="getFieldValue(group.key, field.key) ?? ''"
              :disabled="disabled"
              :placeholder="field.placeholder || ''"
              @input="setFieldValue(group.key, field.key, $event.target.value)"
            />
            <small v-if="field.help" class="field-hint">{{ field.help }}</small>
          </label>
        </template>
      </div>
    </section>
  </div>
</template>

<script setup>
import { reactive } from 'vue'
import CustomSelect from './CustomSelect.vue'
import NumberInput from './NumberInput.vue'

const props = defineProps({
  schema: { type: Object, required: true },      // { groups: [...] }
  modelValue: { type: Object, required: true },   // nested config object
  disabled: { type: Boolean, default: false },
  collapsibleGroups: { type: Boolean, default: true },
})

const emit = defineEmits(['update:modelValue'])

// 组折叠状态
const collapsed = reactive({})

function toggleGroup(key) {
  collapsed[key] = !collapsed[key]
}

/**
 * 从嵌套对象中获取值。
 * 支持 dotted group key，如 "vector_store.sqlite_vec"。
 */
function getFieldValue(groupKey, fieldKey) {
  const parts = groupKey && groupKey !== '_root' ? groupKey.split('.') : []
  let obj = props.modelValue
  for (const part of parts) {
    if (obj == null) return undefined
    obj = obj[part]
  }
  return obj?.[fieldKey]
}

/**
 * 设置嵌套对象中的值，触发 update:modelValue。
 */
function normalizeFieldValue(field, value) {
  if (field?.type === 'select' && field?.nullable && value === '') return null
  return value
}

function setFieldValue(groupKey, fieldKey, value, field = null) {
  const updated = JSON.parse(JSON.stringify(props.modelValue))
  const parts = groupKey && groupKey !== '_root' ? groupKey.split('.') : []
  let obj = updated
  for (const part of parts) {
    if (!obj[part] || typeof obj[part] !== 'object') obj[part] = {}
    obj = obj[part]
  }
  obj[fieldKey] = normalizeFieldValue(field, value)
  emit('update:modelValue', updated)
}
</script>

<style scoped>
@import '../styles/agent-config.css';

.section-head--clickable {
  cursor: pointer;
  user-select: none;
}

.collapse-icon {
  display: inline-block;
  vertical-align: middle;
  margin-left: 6px;
  transition: transform 0.2s ease;
  transform: rotate(-90deg);
  color: var(--color-text-muted);
}
.collapse-icon--open {
  transform: rotate(0deg);
}

.field-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}
</style>
