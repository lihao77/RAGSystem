<template>
  <div class="nodes-container">
    <div class="page-header">
      <h1>节点系统</h1>
      <p class="page-subtitle">查看节点类型、管理配置、执行节点（最小可用版）</p>
    </div>

    <el-row :gutter="16">
      <el-col :span="8">
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
            v-if="selectedNodeType === 'llmjson'"
            title="LLMJson 节点：inputs 支持 text 或 files（目前页面先提供 text）"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 12px"
          />
          <el-alert
            v-if="selectedNodeType === 'json2graph'"
            title="Json2Graph 节点：inputs 需要 json_data（页面用 JSON 文本输入）"
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 12px"
          />

          <div class="section-title">配置 JSON</div>
          <el-input
            v-model="configJson"
            type="textarea"
            :rows="14"
            placeholder="请输入配置 JSON（与后端节点配置字段一致）"
          />

          <div class="section-title" style="margin-top: 12px">执行输入</div>
          <template v-if="selectedNodeType === 'llmjson'">
            <el-input v-model="inputText" type="textarea" :rows="6" placeholder="输入文本（会传给 llmjson 节点的 inputs.text）" />
          </template>
          <template v-else-if="selectedNodeType === 'json2graph'">
            <el-input v-model="inputJsonData" type="textarea" :rows="6" placeholder="输入 json_data（会传给 json2graph 节点的 inputs.json_data）" />
          </template>
          <template v-else>
            <el-input disabled placeholder="请选择节点类型" />
          </template>

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
import {
  getNodeTypes,
  getNodeType,
  getDefaultConfig,
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

const configs = ref([]);
const selectedConfigId = ref('');

const saveName = ref('');
const configJson = ref('{}');

const inputText = ref('');
const inputJsonData = ref('{\n  "基础实体": [],\n  "状态实体": [],\n  "状态关系": []\n}');

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

  try {
    const res = await getNodeType(selectedNodeType.value);
    selectedDefinition.value = res.success ? res.node : null;
  } catch (e) {
    selectedDefinition.value = null;
  }

  await refreshConfigs();
  await loadDefaultConfig();
}

async function loadDefaultConfig() {
  if (!selectedNodeType.value) return;
  const res = await getDefaultConfig(selectedNodeType.value);
  if (res.success) {
    configJson.value = JSON.stringify(res.config, null, 2);
  }
}

async function onSelectConfig() {
  if (!selectedConfigId.value) return;
  const res = await getConfig(selectedConfigId.value);
  if (res.success) {
    configJson.value = JSON.stringify(res.config || {}, null, 2);
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
  const cfg = safeParseJson(configJson.value);
  if (!cfg) {
    ElMessage.error('配置 JSON 解析失败');
    return;
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

  let inputs = {};
  if (selectedNodeType.value === 'llmjson') {
    inputs = { text: inputText.value };
  } else if (selectedNodeType.value === 'json2graph') {
    const jd = safeParseJson(inputJsonData.value);
    if (!jd) {
      ElMessage.error('json_data 解析失败');
      return;
    }
    inputs = { json_data: jd };
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
</style>
