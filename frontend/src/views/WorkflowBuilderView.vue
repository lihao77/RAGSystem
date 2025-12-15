<template>
  <div class="wf-container">
    <div class="page-header">
      <h1>工作流编排</h1>
      <p class="page-subtitle">拖拽节点、选择配置、按顺序执行（最小 Coze 风格）</p>
    </div>

    <el-row :gutter="16">
      <el-col :span="6">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>节点库</span>
              <el-button size="small" @click="refreshAll" :loading="loading">刷新</el-button>
            </div>
          </template>

          <draggable
            :list="palette"
            :group="{ name: 'nodes', pull: 'clone', put: false }"
            :clone="clonePaletteItem"
            item-key="type"
            class="palette"
          >
            <template #item="{ element }">
              <div class="palette-item">
                <div class="title">{{ element.name }}</div>
                <div class="sub">{{ element.type }}</div>
              </div>
            </template>
          </draggable>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div class="card-header">
              <span>工作流</span>
            </div>
          </template>

          <el-select v-model="selectedWorkflowId" placeholder="选择工作流" style="width: 100%" @change="onLoadWorkflow">
            <el-option v-for="w in workflowList" :key="w.id" :label="`${w.name} (${w.id})`" :value="w.id" />
          </el-select>

          <div style="margin-top: 10px; display:flex; gap:8px;">
            <el-button size="small" @click="newWorkflow">新建</el-button>
            <el-button size="small" type="danger" :disabled="!selectedWorkflowId" @click="onDeleteWorkflow">删除</el-button>
          </div>

          <el-divider />

          <el-input v-model="workflowName" placeholder="工作流名称" />
          <el-input v-model="workflowDesc" placeholder="描述(可选)" style="margin-top:8px" />

          <div style="margin-top: 10px; display:flex; gap:8px;">
            <el-button size="small" type="primary" :disabled="!workflowName" :loading="saving" @click="onSaveWorkflow">保存</el-button>
            <el-button size="small" type="success" :disabled="nodes.length===0" :loading="running" @click="onRun">运行</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :span="18">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>画布（顺序执行）</span>
              <span class="hint">从左侧拖拽节点到这里，支持拖拽排序</span>
            </div>
          </template>

          <draggable v-model="nodes" item-key="id" class="canvas" :group="{ name: 'nodes', pull: true, put: true }">
            <template #item="{ element, index }">
              <div class="node-card">
                <div class="node-card-header">
                  <div>
                    <div class="node-title">{{ index + 1 }}. {{ getNodeName(element.node_type) }}</div>
                    <div class="node-sub">{{ element.node_type }} · id={{ element.id }}</div>
                  </div>
                  <div style="display:flex; gap:8px;">
                    <el-button size="small" type="danger" @click="removeNode(index)">移除</el-button>
                  </div>
                </div>

                <el-row :gutter="12">
                  <el-col :span="12">
                    <el-form label-width="90px" size="small">
                      <el-form-item label="配置">
                        <el-select v-model="element.config_id" placeholder="选择配置" style="width:100%" @visible-change="(v)=> v && ensureConfigsLoaded(element.node_type)">
                          <el-option
                            v-for="c in (configsByType[element.node_type] || [])"
                            :key="c.id"
                            :label="`${c.name} (${c.id})${c.is_preset ? ' [preset]' : ''}`"
                            :value="c.id"
                          />
                        </el-select>
                      </el-form-item>
                    </el-form>
                  </el-col>
                  <el-col :span="12" v-if="index===0">
                    <el-form label-width="90px" size="small">
                      <el-form-item label="初始输入">
                        <el-select v-model="firstInputMode" style="width:100%">
                          <el-option label="text" value="text" />
                        </el-select>
                      </el-form-item>
                    </el-form>
                  </el-col>
                </el-row>

                <div v-if="index===0" style="margin-top: 6px">
                  <el-input
                    v-model="firstInputText"
                    type="textarea"
                    :rows="5"
                    placeholder="初始输入文本（会作为 initial_inputs 传给第一个节点）"
                  />
                </div>

                <div class="io-hint">
                  <span v-if="index < nodes.length - 1">输出将自动作为下一个节点输入（同名键对齐）</span>
                  <span v-else>最后一个节点输出为工作流最终输出</span>
                </div>
              </div>
            </template>
          </draggable>

          <el-empty v-if="nodes.length===0" description="拖拽节点到画布开始编排" />
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div class="card-header">
              <span>运行结果</span>
            </div>
          </template>
          <el-input v-model="runResult" type="textarea" :rows="12" readonly />
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import draggable from 'vuedraggable';

import { getNodeTypes, getConfigs } from '@/api/nodeService';
import { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, runWorkflow } from '@/api/workflowService';

const loading = ref(false);
const saving = ref(false);
const running = ref(false);

const palette = ref([]);
const nodeTypesMap = reactive({});

const nodes = ref([]);

const configsByType = reactive({});

const workflowList = ref([]);
const selectedWorkflowId = ref('');
const workflowId = ref('');
const workflowName = ref('');
const workflowDesc = ref('');

const firstInputMode = ref('text');
const firstInputText = ref('');

const runResult = ref('');

function getNodeName(type) {
  return nodeTypesMap[type]?.name || type;
}

function clonePaletteItem(item) {
  return {
    id: Math.random().toString(16).slice(2, 10),
    node_type: item.type,
    config_id: null
  };
}

async function refreshNodeTypes() {
  const res = await getNodeTypes();
  if (!res.success) return;
  palette.value = res.nodes;
  for (const n of res.nodes) nodeTypesMap[n.type] = n;
}

async function ensureConfigsLoaded(nodeType) {
  if (configsByType[nodeType]) return;
  const res = await getConfigs(nodeType, true);
  if (res.success) configsByType[nodeType] = res.configs;
}

async function refreshWorkflows() {
  const res = await listWorkflows();
  if (res.success) workflowList.value = res.workflows;
}

async function refreshAll() {
  loading.value = true;
  try {
    await refreshNodeTypes();
    await refreshWorkflows();
  } finally {
    loading.value = false;
  }
}

function newWorkflow() {
  selectedWorkflowId.value = '';
  workflowId.value = '';
  workflowName.value = '';
  workflowDesc.value = '';
  nodes.value = [];
  runResult.value = '';
  firstInputText.value = '';
}

async function onLoadWorkflow() {
  if (!selectedWorkflowId.value) return;
  const res = await getWorkflow(selectedWorkflowId.value);
  if (!res.success) return;
  const wf = res.workflow;
  workflowId.value = wf.id;
  workflowName.value = wf.name;
  workflowDesc.value = wf.description;
  nodes.value = (wf.nodes || []).map(n => ({ id: n.id, node_type: n.node_type, config_id: n.config_id || null }));

  // 预加载配置列表
  for (const n of nodes.value) await ensureConfigsLoaded(n.node_type);
}

async function onSaveWorkflow() {
  if (!workflowName.value.trim()) {
    ElMessage.warning('请输入工作流名称');
    return;
  }
  saving.value = true;
  try {
    const wf = {
      id: workflowId.value || undefined,
      name: workflowName.value.trim(),
      description: workflowDesc.value,
      nodes: nodes.value.map(n => ({ id: n.id, node_type: n.node_type, config_id: n.config_id || null }))
    };
    const res = await saveWorkflow(wf);
    if (res.success) {
      workflowId.value = res.workflow.id;
      selectedWorkflowId.value = res.workflow.id;
      ElMessage.success('保存成功');
      await refreshWorkflows();
    } else {
      ElMessage.error(res.error || '保存失败');
    }
  } finally {
    saving.value = false;
  }
}

async function onDeleteWorkflow() {
  if (!selectedWorkflowId.value) return;
  await ElMessageBox.confirm('确认删除该工作流？', '提示', { type: 'warning' });
  const res = await deleteWorkflow(selectedWorkflowId.value);
  if (res.success) {
    ElMessage.success('删除成功');
    newWorkflow();
    await refreshWorkflows();
  } else {
    ElMessage.error(res.error || '删除失败');
  }
}

function removeNode(index) {
  nodes.value.splice(index, 1);
}

async function onRun() {
  if (!workflowId.value) {
    ElMessage.warning('请先保存工作流再运行');
    return;
  }
  if (nodes.value.length === 0) {
    ElMessage.warning('请先拖拽节点到画布');
    return;
  }

  const initialInputs = {};
  if (firstInputMode.value === 'text') initialInputs.text = firstInputText.value;

  running.value = true;
  try {
    const res = await runWorkflow(workflowId.value, initialInputs);
    runResult.value = JSON.stringify(res, null, 2);
    if (res.success) ElMessage.success('运行完成');
    else ElMessage.error(res.error || '运行失败');
  } catch (e) {
    runResult.value = String(e);
    ElMessage.error(e.message || '运行失败');
  } finally {
    running.value = false;
  }
}

onMounted(async () => {
  await refreshAll();
});
</script>

<style scoped>
.wf-container {
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
.hint {
  color: #909399;
  font-size: 12px;
}
.palette {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.palette-item {
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 10px;
  cursor: grab;
  background: #fff;
}
.palette-item .title {
  font-weight: 600;
}
.palette-item .sub {
  color: #909399;
  font-size: 12px;
}
.canvas {
  min-height: 200px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.node-card {
  border: 1px solid #ebeef5;
  border-radius: 10px;
  padding: 12px;
  background: #fff;
}
.node-card-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.node-title {
  font-weight: 700;
}
.node-sub {
  color: #909399;
  font-size: 12px;
}
.io-hint {
  margin-top: 8px;
  color: #909399;
  font-size: 12px;
}
</style>
