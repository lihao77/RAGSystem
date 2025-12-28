<template>
  <div class="node-config-editor">
    <!-- 视图切换 -->
    <div class="view-switcher">
      <el-radio-group v-model="viewMode" size="small">
        <el-radio-button value="form">表单视图</el-radio-button>
        <el-radio-button value="json">JSON视图</el-radio-button>
      </el-radio-group>
    </div>

    <!-- 表单视图 -->
    <div v-show="viewMode === 'form'" class="form-view">
      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-width="auto"
        label-position="right"
        size="default"
      >
        <!-- 动态生成表单项 -->
        <template v-for="group in configGroups" :key="group.name">
          <el-divider content-position="left">
            <span class="group-title">{{ group.label }}</span>
          </el-divider>

          <el-form-item
            v-for="field in group.fields"
            :key="field.name"
            :label="field.label"
            :prop="field.name"
            :required="field.required"
          >
            <template #label>
              <span>{{ field.label }}</span>
              <el-tooltip v-if="field.description" :content="field.description" placement="top">
                <el-icon style="margin-left: 4px; color: #909399; cursor: help;">
                  <QuestionFilled />
                </el-icon>
              </el-tooltip>
            </template>

            <!-- File selector -->
            <FileSelector
              v-if="field.type === 'file_selector'"
              v-model="formData[field.name]"
              :multiple="field.multiple"
              :file-extensions="field.fileExtensions"
              :mime-types="field.mimeTypes"
              :placeholder="field.placeholder"
              :disabled="field.disabled"
            />

            <!-- 字符串输入 -->
            <el-input
              v-else-if="field.type === 'string' && !field.options"
              v-model="formData[field.name]"
              :placeholder="field.placeholder || field.description"
              :disabled="field.disabled"
              clearable
            />

            <!-- 多行文本 -->
            <el-input
              v-else-if="field.type === 'text'"
              v-model="formData[field.name]"
              type="textarea"
              :rows="field.rows || 3"
              :placeholder="field.placeholder || field.description"
              :disabled="field.disabled"
            />

            <!-- 数字输入 -->
            <el-input-number
              v-else-if="field.type === 'number' || field.type === 'integer'"
              v-model="formData[field.name]"
              :min="field.min"
              :max="field.max"
              :step="field.step || 1"
              :precision="field.type === 'integer' ? 0 : field.precision"
              :disabled="field.disabled"
              style="width: 100%"
            />

            <!-- 布尔开关 -->
            <el-switch
              v-else-if="field.type === 'boolean'"
              v-model="formData[field.name]"
              :disabled="field.disabled"
            />

            <!-- 下拉选择 -->
            <el-select
              v-else-if="field.options"
              v-model="formData[field.name]"
              :placeholder="field.placeholder || '请选择'"
              :disabled="field.disabled"
              clearable
              style="width: 100%"
            >
              <el-option
                v-for="opt in field.options"
                :key="opt.value"
                :label="opt.label"
                :value="opt.value"
              />
            </el-select>

            <!-- JSON编辑器（包括对象和复杂数组） -->
            <div v-else-if="field.type === 'json' || field.type === 'array' || field.type === 'object' || field.format === 'json'" class="json-field">
              <el-input
                v-model="formData[field.name]"
                type="textarea"
                :rows="field.rows || 4"
                :placeholder="field.placeholder || 'JSON格式'"
                :disabled="field.disabled"
              />
              <el-button
                size="small"
                text
                @click="formatJsonField(field.name)"
                style="margin-top: 4px"
              >
                格式化
              </el-button>
            </div>

            <!-- 简单数组编辑器（仅用于字符串数组） -->
            <div v-else-if="field.type === 'array' && field.format !== 'json'" class="array-field">
              <el-tag
                v-for="(item, idx) in formData[field.name]"
                :key="idx"
                closable
                @close="removeArrayItem(field.name, idx)"
                style="margin-right: 8px; margin-bottom: 8px"
              >
                {{ item }}
              </el-tag>
              <el-input
                v-model="arrayInputs[field.name]"
                size="small"
                :placeholder="`添加${field.label}`"
                style="width: 200px; margin-top: 8px"
                @keyup.enter="addArrayItem(field.name)"
              >
                <template #append>
                  <el-button @click="addArrayItem(field.name)">添加</el-button>
                </template>
              </el-input>
            </div>

            <!-- 密码输入 -->
            <el-input
              v-else-if="field.name.includes('password') || field.name.includes('secret') || field.name.includes('key')"
              v-model="formData[field.name]"
              type="password"
              show-password
              :placeholder="field.placeholder || field.description"
              :disabled="field.disabled"
              clearable
            />

            <!-- 默认输入 -->
            <el-input
              v-else
              v-model="formData[field.name]"
              :placeholder="field.placeholder || field.description"
              :disabled="field.disabled"
              clearable
            />
          </el-form-item>
        </template>
      </el-form>
    </div>

    <!-- JSON视图 -->
    <div v-show="viewMode === 'json'" class="json-view">
      <el-input
        v-model="jsonText"
        type="textarea"
        :rows="20"
        placeholder="请输入配置 JSON"
        @blur="syncFromJson"
      />
      <div class="json-actions">
        <el-button size="small" @click="formatJsonText">格式化</el-button>
        <el-button size="small" @click="validateJson">验证</el-button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { QuestionFilled } from '@element-plus/icons-vue';
import FileSelector from '@/components/FileSelector.vue';

const props = defineProps({
  // 节点类型定义
  nodeDefinition: {
    type: Object,
    default: () => null
  },
  // 初始配置值（对象格式）
  modelValue: {
    type: Object,
    default: () => ({})
  },
  // 配置schema（用于生成表单）
  configSchema: {
    type: Object,
    default: () => null
  }
});

const emit = defineEmits(['update:modelValue', 'validate']);

const viewMode = ref('form');
const formRef = ref(null);
const formData = ref({});
const jsonText = ref('{}');
const arrayInputs = ref({});

// 从配置schema生成表单规则
const formRules = computed(() => {
  if (!props.configSchema) return {};
  
  const rules = {};
  Object.entries(props.configSchema.properties || {}).forEach(([key, schema]) => {
    const fieldRules = [];
    
    if (props.configSchema.required?.includes(key)) {
      fieldRules.push({
        required: true,
        message: `${schema.title || key} 不能为空`,
        trigger: 'blur'
      });
    }
    
    if (schema.pattern) {
      fieldRules.push({
        pattern: new RegExp(schema.pattern),
        message: schema.patternMessage || '格式不正确',
        trigger: 'blur'
      });
    }
    
    if (schema.minLength) {
      fieldRules.push({
        min: schema.minLength,
        message: `最少${schema.minLength}个字符`,
        trigger: 'blur'
      });
    }
    
    if (fieldRules.length > 0) {
      rules[key] = fieldRules;
    }
  });
  
  return rules;
});

// 从配置schema生成分组表单字段
const configGroups = computed(() => {
  if (!props.configSchema) return [];
  
  const groups = [];
  const properties = props.configSchema.properties || {};
  const groupMap = {};
  
  // 按分组组织字段
  Object.entries(properties).forEach(([key, schema]) => {
    const group = schema.group || 'default';
    if (!groupMap[group]) {
      groupMap[group] = {
        name: group,
        label: schema.groupLabel || (group === 'default' ? '基础配置' : group),
        order: schema.groupOrder || 999,
        fields: []
      };
    }
    
    groupMap[group].fields.push({
      name: key,
      label: schema.title || key,
      description: schema.description,
      type: mapSchemaType(schema),
      format: schema.format,
      required: props.configSchema.required?.includes(key),
      disabled: schema.readOnly,
      placeholder: schema.placeholder,
      options: schema.enum ? schema.enum.map(v => ({ label: v, value: v })) : schema.options,
      min: schema.minimum,
      max: schema.maximum,
      step: schema.multipleOf,
      precision: schema.precision,
      rows: schema.rows,
      order: schema.order || 999,
      // File selector specific metadata
      fileExtensions: schema.fileExtensions,
      mimeTypes: schema.mimeTypes,
      multiple: schema.multiple
    });
  });
  
  // 排序并返回
  Object.values(groupMap).forEach(group => {
    group.fields.sort((a, b) => a.order - b.order);
    groups.push(group);
  });
  
  groups.sort((a, b) => a.order - b.order);
  
  return groups;
});

// 映射schema类型到表单控件类型
function mapSchemaType(schema) {
  if (schema.format === 'file_selector') return 'file_selector';
  if (schema.format === 'textarea') return 'text';
  if (schema.format === 'json') return 'json';
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number') return 'number';
  if (schema.type === 'integer') return 'integer';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'array') return 'array';
  if (schema.type === 'object') return 'json';
  return 'string';
}

// 初始化表单数据
function initFormData() {
  const data = { ...props.modelValue };
  
  // 处理特殊字段类型
  if (props.configSchema) {
    Object.entries(props.configSchema.properties || {}).forEach(([key, schema]) => {
      // JSON/对象/数组类型需要转换为字符串
      if (schema.format === 'json' || schema.type === 'object' || 
          (schema.type === 'array' && schema.format === 'json')) {
        if (data[key] !== undefined && data[key] !== null) {
          // 如果已经是字符串，保持不变
          if (typeof data[key] !== 'string') {
            data[key] = JSON.stringify(data[key], null, 2);
          }
        } else if (schema.default !== undefined) {
          // 使用默认值
          data[key] = typeof schema.default === 'string' 
            ? schema.default 
            : JSON.stringify(schema.default, null, 2);
        }
      }
      // 简单数组类型
      else if (schema.type === 'array' && !Array.isArray(data[key])) {
        data[key] = data[key] ? [data[key]] : [];
      }
    });
  }
  
  formData.value = data;
  syncToJson();
}

// 同步表单数据到JSON
function syncToJson() {
  // 处理JSON字符串字段，先解析再序列化，避免双重转义
  const dataForJson = { ...formData.value };

  if (props.configSchema) {
    Object.entries(props.configSchema.properties || {}).forEach(([key, schema]) => {
      if ((schema.format === 'json' || schema.type === 'object' ||
           (schema.type === 'array' && schema.format === 'json')) &&
          typeof dataForJson[key] === 'string') {
        try {
          dataForJson[key] = JSON.parse(dataForJson[key]);
        } catch (e) {
          // 如果解析失败，保持原字符串
        }
      }
    });
  }

  jsonText.value = JSON.stringify(dataForJson, null, 2);
}

// 从JSON同步到表单
function syncFromJson() {
  try {
    const parsed = JSON.parse(jsonText.value);
    formData.value = parsed;
    emit('update:modelValue', parsed);
  } catch (e) {
    ElMessage.error('JSON格式错误');
  }
}

// 格式化JSON文本
function formatJsonText() {
  try {
    const parsed = JSON.parse(jsonText.value);
    jsonText.value = JSON.stringify(parsed, null, 2);
    ElMessage.success('格式化成功');
  } catch (e) {
    ElMessage.error('JSON格式错误');
  }
}

// 验证JSON
function validateJson() {
  try {
    JSON.parse(jsonText.value);
    ElMessage.success('JSON格式正确');
  } catch (e) {
    ElMessage.error(`JSON格式错误: ${e.message}`);
  }
}

// 格式化单个JSON字段
function formatJsonField(fieldName) {
  try {
    const parsed = JSON.parse(formData.value[fieldName]);
    formData.value[fieldName] = JSON.stringify(parsed, null, 2);
    ElMessage.success('格式化成功');
  } catch (e) {
    ElMessage.error('JSON格式错误');
  }
}

// 添加数组项
function addArrayItem(fieldName) {
  const value = arrayInputs.value[fieldName];
  if (!value || !value.trim()) return;
  
  if (!Array.isArray(formData.value[fieldName])) {
    formData.value[fieldName] = [];
  }
  
  formData.value[fieldName].push(value.trim());
  arrayInputs.value[fieldName] = '';
}

// 删除数组项
function removeArrayItem(fieldName, index) {
  formData.value[fieldName].splice(index, 1);
}

// 验证表单
async function validate() {
  if (!formRef.value) return true;
  
  try {
    await formRef.value.validate();
    emit('validate', true, null);
    return true;
  } catch (errors) {
    emit('validate', false, errors);
    return false;
  }
}

// 获取表单数据
function getFormData() {
  const data = { ...formData.value };
  
  // 将JSON字符串字段转换回对象
  if (props.configSchema) {
    Object.entries(props.configSchema.properties || {}).forEach(([key, schema]) => {
      if (schema.format === 'json' || schema.type === 'object' || 
          (schema.type === 'array' && schema.format === 'json')) {
        if (typeof data[key] === 'string' && data[key]) {
          try {
            data[key] = JSON.parse(data[key]);
          } catch (e) {
            // 如果解析失败，保持原值
            console.warn(`Failed to parse JSON field ${key}:`, e);
          }
        }
      }
    });
  }
  
  return data;
}

// 重置表单
function resetForm() {
  if (formRef.value) {
    formRef.value.resetFields();
  }
}

// 监听表单数据变化
watch(formData, (newVal) => {
  // 解析 JSON 字符串字段
  const parsedData = { ...newVal };
  if (props.configSchema) {
    Object.entries(props.configSchema.properties || {}).forEach(([key, schema]) => {
      if ((schema.format === 'json' || schema.type === 'object' ||
           (schema.type === 'array' && schema.format === 'json')) &&
          typeof parsedData[key] === 'string') {
        try {
          parsedData[key] = JSON.parse(parsedData[key]);
        } catch (e) {
          // 保持原字符串
        }
      }
    });
  }
  emit('update:modelValue', parsedData);
  syncToJson();
}, { deep: true });

// 监听外部值变化
watch(() => props.modelValue, (newVal) => {
  if (JSON.stringify(newVal) !== JSON.stringify(formData.value)) {
    initFormData();
  }
}, { deep: true });

// 暴露方法给父组件
defineExpose({
  validate,
  getFormData,
  resetForm
});

onMounted(() => {
  initFormData();
});
</script>

<style scoped>
.node-config-editor {
  width: 100%;
}

.view-switcher {
  margin-bottom: 16px;
  display: flex;
  justify-content: flex-end;
}

.form-view {
  /* max-height: 600px; */
  overflow-y: auto;
  padding-right: 8px;
}

.group-title {
  font-weight: 600;
  color: #409eff;
  font-size: 14px;
}

.json-view {
  position: relative;
}

.json-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}

.json-field,
.array-field {
  width: 100%;
}

.array-field .el-tag {
  cursor: pointer;
}

:deep(.el-form-item__label) {
  font-weight: 500;
}

:deep(.el-divider__text) {
  background-color: #f5f7fa;
}
</style>
