<template>
  <div class="nodes-container">
    <div class="page-header">
      <h1>节点系统</h1>
      <p class="page-subtitle">查看节点类型、管理配置、执行节点（最小可用版）</p>
    </div>

    <el-row :gutter="16">
      <el-col :span="8" class="left-sidebar">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>节点类型</span>
              <el-button size="small" @click="refreshAll" :loading="loading">刷新</el-button>
            </div>
          </template>

          <el-select v-model="selectedNodeType" placeholder="选择节点类型" style="width: 100%" @change="onSelectNodeType">
            <el-option v-for="n in nodeTypes" :key="n.type" :label="`${n.name} (${n.type})`" :value="n.type" />
          </el-select>

          <div v-if="selectedDefinition" class="node-meta">
            <el-descriptions :column="1" size="small" border style="margin-top: 12px">
              <el-descriptions-item label="名称">{{ selectedDefinition.name }}</el-descriptions-item>
              <el-descriptions-item label="类型">{{ selectedDefinition.type }}</el-descriptions-item>
              <el-descriptions-item label="分类">{{ selectedDefinition.category }}</el-descriptions-item>
              <el-descriptions-item label="版本">{{ selectedDefinition.version }}</el-descriptions-item>
            </el-descriptions>
            <div class="desc">{{ selectedDefinition.description }}</div>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px" v-if="selectedNodeType">
          <template #header>
            <div class="card-header">
              <span>已保存配置</span>
            </div>
          </template>

          <el-select v-model="selectedConfigId" placeholder="选择配置" style="width: 100%" @change="onSelectConfig">
            <el-option
              v-for="c in configs"
              :key="c.id"
              :label="`${c.name} (${c.id})${c.is_preset ? ' [preset]' : ''}`"
              :value="c.id"
            />
          </el-select>

          <div style="margin-top: 10px; display: flex; gap: 8px">
            <el-button size="small" @click="loadDefaultConfig" :disabled="!selectedNodeType">载入默认</el-button>
            <el-button size="small" type="danger" @click="onDeleteConfig" :disabled="!selectedConfigId">删除</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :span="16">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>配置编辑</span>
              <div style="display:flex; gap:8px; align-items:center;">
                <el-input v-model="saveName" size="small" placeholder="配置名称（保存用）" style="width: 220px" />
                <el-button size="small" type="primary" @click="onSaveConfig" :loading="saving" :disabled="!selectedNodeType">保存配置</el-button>
              </div>
            </div>
          </template>

          <el-alert
            v-if="selectedDefinition && selectedDefinition.inputs && selectedDefinition.inputs.length > 0"
            :title="`该节点需要 ${selectedDefinition.inputs.length} 个输入参数`"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 12px"
          />

          <!-- 使用新的配置编辑器 -->
          <NodeConfigEditor
            v-if="configSchema"
            ref="configEditorRef"
            v-model="configJson"
            :node-definition="selectedDefinition"
            :config-schema="configSchema"
          />
          
          <!-- 降级到JSON编辑器 -->
          <div v-else>
            <div class="section-title">配置 JSON</div>
            <el-input
              v-model="configJson"
              type="textarea"
              :rows="14"
              placeholder="请输入配置 JSON（与后端节点配置字段一致）"
            />
            <div style="margin-top: 12px; display:flex; gap:8px">
              <el-button @click="formatJson">格式化JSON</el-button>
            </div>
          </div>

          <div class="section-title" style="margin-top: 12px">
            执行输入
            <el-text size="small" type="info" style="margin-left: 8px">
              (动态生成，基于节点定义)
            </el-text>
          </div>
          
          <!-- 动态生成输入表单 -->
          <div v-if="selectedDefinition && selectedDefinition.inputs && selectedDefinition.inputs.length > 0" class="dynamic-inputs">
            <el-form label-width="120px" size="small">
              <el-form-item 
                v-for="input in selectedDefinition.inputs" 
                :key="input.name"
                :label="input.name"
                :required="input.required"
              >
                <!-- text 类型 -> textarea -->
                <el-input 
                  v-if="input.type === 'text'"
                  v-model="dynamicInputs[input.name]"
                  type="textarea"
                  :rows="4"
                  :placeholder="input.description"
                />
                
                <!-- string 类型 -> input -->
                <el-input 
                  v-else-if="input.type === 'string'"
                  v-model="dynamicInputs[input.name]"
                  :placeholder="input.description"
                />
                
                <!-- integer/number 类型 -> input-number -->
                <el-input-number 
                  v-else-if="input.type === 'integer' || input.type === 'number'"
                  v-model="dynamicInputs[input.name]"
                  style="width: 100%"
                />
                
                <!-- bool 类型 -> switch -->
                <el-switch 
                  v-else-if="input.type === 'bool'"
                  v-model="dynamicInputs[input.name]"
                />
                
                <!-- json 类型 -> textarea (JSON) -->
                <el-input 
                  v-else-if="input.type === 'json'"
                  v-model="dynamicInputs[input.name]"
                  type="textarea"
                  :rows="4"
                  :placeholder="`${input.description} (JSON 格式)`"
                />
                
                <!-- file_id 类型 -> 单文件选择器 -->
                <FileSelector
                  v-else-if="input.name === 'file_id' || input.name.endsWith('_file_id')"
                  v-model="dynamicInputs[input.name]"
                  :multiple="false"
                  :placeholder="input.description || '选择文件'"
                />
                
                <!-- file_ids 或 array 类型且名称包含 file -> 多文件选择器 -->
                <FileSelector
                  v-else-if="input.name === 'file_ids' || input.name.endsWith('_file_ids') || (input.type === 'array' && (input.name.includes('file') || input.description?.toLowerCase().includes('file')))"
                  v-model="dynamicInputs[input.name]"
                  :multiple="true"
                  :placeholder="input.description || '选择文件'"
                />
                
                <!-- array 类型 -> textarea (JSON array) -->
                <el-input 
                  v-else-if="input.type === 'array'"
                  v-model="dynamicInputs[input.name]"
                  type="textarea"
                  :rows="3"
                  :placeholder="`${input.description} (JSON 数组格式)`"
                />
                
                <!-- 其他类型 -> 通用 input -->
                <el-input 
                  v-else
                  v-model="dynamicInputs[input.name]"
                  :placeholder="`${input.description} (${input.type})`"
                />
                
                <el-text size="small" type="info" style="margin-top: 4px">
                  类型: {{ input.type }} {{ input.required ? '(必填)' : '(可选)' }}
                </el-text>
              </el-form-item>
            </el-form>
          </div>
          
          <!-- 无输入的节点 -->
          <el-alert 
            v-else-if="selectedDefinition && (!selectedDefinition.inputs || selectedDefinition.inputs.length === 0)"
            title="该节点无需输入参数"
            type="info"
            :closable="false"
            show-icon
          />
          
          <!-- 未选择节点 -->
          <el-input v-else disabled placeholder="请先选择节点类型" />

          <div style="margin-top: 12px; display:flex; gap:8px">
            <el-button type="success" @click="onExecute" :loading="executing" :disabled="!selectedNodeType">执行节点</el-button>
            <el-button @click="formatJson">格式化JSON</el-button>
          </div>

          <div class="section-title" style="margin-top: 12px">执行结果</div>
          <el-input v-model="resultJson" type="textarea" :rows="10" readonly />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import NodeConfigEditor from '@/components/workflow/NodeConfigEditor.vue';
import FileSelector from '@/components/FileSelector.vue';
import {
  getNodeTypes,
  getNodeType,
  getDefaultConfig,
  getConfigSchema,
  getConfigs,
  getConfig,
  saveConfig,
  deleteConfig,
  executeNode
} from '@/api/nodeService';

defineOptions({ name: 'NodesView' });

const loading = ref(false);
const saving = ref(false);
const executing = ref(false);

const nodeTypes = ref([]);
const selectedNodeType = ref('');
const selectedDefinition = ref(null);
const configSchema = ref(null);

const configs = ref([]);
const selectedConfigId = ref('');

const saveName = ref('');
const configJson = ref('{}');
const configEditorRef = ref(null);

// 动态输入（基于节点定义）
const dynamicInputs = ref({});

const resultJson = ref('');

async function refreshNodeTypes() {
  const res = await getNodeTypes();
  if (res.success) nodeTypes.value = res.nodes;
}

async function refreshConfigs() {
  if (!selectedNodeType.value) return;
  const res = await getConfigs(selectedNodeType.value, true);
  if (res.success) configs.value = res.configs;
}

async function refreshAll() {
  loading.value = true;
  try {
    await refreshNodeTypes();
    await refreshConfigs();
  } finally {
    loading.value = false;
  }
}

async function onSelectNodeType() {
  selectedConfigId.value = '';
  resultJson.value = '';
  saveName.value = '';
  configSchema.value = null;

  try {
    const res = await getNodeType(selectedNodeType.value);
    selectedDefinition.value = res.success ? res.node : null;
    
    // 获取配置schema
    const schemaRes = await getConfigSchema(selectedNodeType.value);
    if (schemaRes.success) {
      configSchema.value = schemaRes.schema;
    }
  } catch (e) {
    selectedDefinition.value = null;
    configSchema.value = null;
  }

  await refreshConfigs();
  await loadDefaultConfig();
}

async function loadDefaultConfig() {
  if (!selectedNodeType.value) return;
  const res = await getDefaultConfig(selectedNodeType.value);
  if (res.success) {
    configJson.value = res.config;
  }
}

async function onSelectConfig() {
  if (!selectedConfigId.value) return;
  const res = await getConfig(selectedConfigId.value);
  if (res.success) {
    // 直接更新对象，让配置编辑器响应
    const parsedConfig = res.config || {};
    configJson.value = parsedConfig;
    saveName.value = res.metadata?.name || '';
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function formatJson() {
  const obj = safeParseJson(configJson.value);
  if (!obj) {
    ElMessage.error('配置 JSON 解析失败');
    return;
  }
  configJson.value = JSON.stringify(obj, null, 2);
}

async function onSaveConfig() {
  if (!selectedNodeType.value) return;
  if (!saveName.value.trim()) {
    ElMessage.warning('请输入配置名称');
    return;
  }
  
  // 从配置编辑器获取数据
  let cfg;
  if (configEditorRef.value) {
    // 验证表单
    const valid = await configEditorRef.value.validate();
    if (!valid) {
      ElMessage.error('配置验证失败，请检查必填项');
      return;
    }
    cfg = configEditorRef.value.getFormData();
  } else {
    cfg = safeParseJson(configJson.value);
    if (!cfg) {
      ElMessage.error('配置 JSON 解析失败');
      return;
    }
  }

  saving.value = true;
  try {
    let res;
    try {
      res = await saveConfig({
        node_type: selectedNodeType.value,
        name: saveName.value.trim(),
        config: cfg,
        description: '',
        overwrite: false
      });
    } catch (e) {
      // 后端在同名时返回 409 + error 文案（http.js 会把 error 放到 Error.message）
      const msg = e?.message || '';
      const isConflict = msg.includes('名称已存在') || msg.includes('是否覆盖');
      if (isConflict) {
        const confirm = await ElMessageBox.confirm(
          '已存在同名配置，是否覆盖？',
          '确认覆盖',
          { type: 'warning', confirmButtonText: '覆盖', cancelButtonText: '取消' }
        ).then(() => true).catch(() => false);

        if (!confirm) return;

        res = await saveConfig({
          node_type: selectedNodeType.value,
          name: saveName.value.trim(),
          config: cfg,
          description: '',
          overwrite: true
        });
      } else {
        throw e;
      }
    }

    if (res?.success) {
      ElMessage.success(res.overwritten ? '覆盖保存成功' : '保存成功');
      await refreshConfigs();
    } else {
      ElMessage.error(res?.error || '保存失败');
    }
  } finally {
    saving.value = false;
  }
}

async function onDeleteConfig() {
  if (!selectedConfigId.value) return;
  await ElMessageBox.confirm('确认删除该配置？', '提示', { type: 'warning' });
  const res = await deleteConfig(selectedConfigId.value);
  if (res.success) {
    ElMessage.success('删除成功');
    selectedConfigId.value = '';
    await refreshConfigs();
  } else {
    ElMessage.error(res.error || '删除失败');
  }
}

async function onExecute() {
  if (!selectedNodeType.value) return;
  const cfg = safeParseJson(configJson.value);
  if (!cfg) {
    ElMessage.error('配置 JSON 解析失败');
    return;
  }

  // 动态构建输入（自动处理 JSON 类型）
  const inputs = {};
  if (selectedDefinition.value && selectedDefinition.value.inputs) {
    for (const inputDef of selectedDefinition.value.inputs) {
      const name = inputDef.name;
      let value = dynamicInputs.value[name];
      
      // 跳过空值（除非是必填）
      if (!value && value !== 0 && value !== false) {
        if (inputDef.required) {
          ElMessage.warning(`必填参数 "${name}" 不能为空`);
          return;
        }
        continue;
      }
      
      // 根据类型转换
      if (inputDef.type === 'json' || inputDef.type === 'array') {
        // JSON/Array 类型需要解析
        const parsed = safeParseJson(value);
        if (parsed === null && value) {
          ElMessage.error(`参数 "${name}" 的 JSON 格式错误`);
          return;
        }
        inputs[name] = parsed;
      } else if (inputDef.type === 'integer') {
        inputs[name] = parseInt(value);
      } else if (inputDef.type === 'number') {
        inputs[name] = parseFloat(value);
      } else if (inputDef.type === 'bool') {
        inputs[name] = Boolean(value);
      } else {
        // text, string 等直接使用
        inputs[name] = value;
      }
    }
  }

  executing.value = true;
  try {
    const res = await executeNode({
      node_type: selectedNodeType.value,
      config: cfg,
      inputs
    });
    resultJson.value = JSON.stringify(res, null, 2);
    if (res.success) ElMessage.success('执行完成');
    else ElMessage.error(res.error || '执行失败');
  } catch (e) {
    resultJson.value = String(e);
    ElMessage.error(e.message || '执行失败');
  } finally {
    executing.value = false;
  }
}

onMounted(async () => {
  await refreshAll();
});
</script>

<style scoped>
.nodes-container {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px;
  min-height: 100vh;
}
.page-header {
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}
.page-header h1 {
  margin: 0 0 6px 0;
  font-size: 28px;
  font-weight: 500;
  color: #303133;
}
.page-subtitle {
  margin: 0;
  font-size: 14px;
  color: #909399;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.node-meta .desc {
  margin-top: 10px;
  color: #606266;
  font-size: 13px;
}
.section-title {
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}
.dynamic-inputs {
  border: 1px solid #e4e7ed;
  border-radius: 4px;
  padding: 16px;
  background-color: #f5f7fa;
}
.dynamic-inputs :deep(.el-form-item) {
  margin-bottom: 16px;
}
.dynamic-inputs :deep(.el-form-item__label) {
  font-weight: 500;
}

/* 左侧栏固定定位 */
.left-sidebar {
  position: sticky;
  top: 0px;
  height: fit-content;
  /* max-height: calc(100vh - 40px); */
  overflow-y: auto;
}

/* 自定义滚动条样式 */
.left-sidebar::-webkit-scrollbar {
  width: 6px;
}

.left-sidebar::-webkit-scrollbar-track {
  background: #f5f7fa;
}

.left-sidebar::-webkit-scrollbar-thumb {
  background: #dcdfe6;
  border-radius: 3px;
}

.left-sidebar::-webkit-scrollbar-thumb:hover {
  background: #c0c4cc;
}
</style>
