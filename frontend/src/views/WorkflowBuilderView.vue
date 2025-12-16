<template>
  <div class="wf-container">
    <div class="page-header">
      <h1>工作流编排</h1>
      <p class="page-subtitle">可视化 DAG：拖拽节点、拖线连边、选择配置、拓扑执行</p>
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

          <div class="palette">
            <div
              v-for="n in palette"
              :key="n.type"
              class="palette-item"
              draggable="true"
              @dragstart="onDragStart($event, n.type)"
              @click="addNodeAtCenter(n.type)"
              title="拖拽到画布，或点击添加"
            >
              <div class="title">{{ n.name }}</div>
              <div class="sub">{{ n.type }}</div>
            </div>
          </div>
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
            <el-button size="small" :disabled="vfNodes.length===0" @click="onValidate">检查</el-button>
            <el-button size="small" type="success" :disabled="vfNodes.length===0" :loading="running" @click="onRun">运行</el-button>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px">
          <template #header>
            <div class="card-header">
              <span>全局输入（initial_inputs）</span>
            </div>
          </template>

          <el-select v-model="firstInputMode" style="width:100%">
            <el-option label="text" value="text" />
            <el-option label="file_ids" value="file_ids" />
          </el-select>

          <div style="margin-top: 8px">
            <template v-if="firstInputMode==='text'">
              <el-input v-model="firstInputText" type="textarea" :rows="3" placeholder="initial_inputs.text" />
            </template>
            <template v-else>
              <el-select v-model="firstInputFileIds" multiple filterable placeholder="选择文件" style="width:100%">
                <el-option v-for="f in availableFiles" :key="f.id" :label="`${f.original_name} (${f.id})`" :value="f.id" />
              </el-select>
            </template>
          </div>

          <div style="margin-top: 10px; font-weight: 600;">额外 initial_inputs（JSON）</div>
          <el-input v-model="initialInputsJson" type="textarea" :rows="4" placeholder='例如：{"foo": "bar"}' />
        </el-card>
      </el-col>

      <el-col :span="18">
        <el-card shadow="never">
          <template #header>
            <div class="card-header">
              <span>画布（拖线连边）</span>
              <span class="hint">拖拽节点到画布；从右侧输出端口拖线到左侧输入端口</span>
            </div>
          </template>

          <div class="flow-wrapper" @drop="onDrop" @dragover="onDragOver">
            <VueFlow
              v-model:nodes="vfNodes"
              v-model:edges="vfEdges"
              :node-types="nodeTypes"
              :fit-view-on-init="true"
              :is-valid-connection="isValidConnection"
              class="flow"
              @connect-start="onConnectStart"
              @connect-end="onConnectEnd"
              @connect="onConnect"
              @node-click="onNodeClick"
              @edge-click="onEdgeClick"
              @pane-click="onPaneClick"
              @nodes-change="onNodesChange"
            >
              <Background />
              <Controls />
            </VueFlow>
          </div>
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

    <el-drawer v-model="drawerOpen" title="节点配置" size="420px" destroy-on-close>
      <div v-if="activeNode">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="节点ID">{{ activeNode.id }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ activeNode.data.node_type }}</el-descriptions-item>
        </el-descriptions>

        <div style="margin-top: 12px; font-weight:600;">选择配置</div>
        <el-select v-model="activeNode.data.config_id" placeholder="选择配置" style="width:100%" @visible-change="(v)=> v && ensureConfigsLoaded(activeNode.data.node_type)">
          <el-option v-for="c in (configsByType[activeNode.data.node_type] || [])" :key="c.id" :label="`${c.name} (${c.id})${c.is_preset ? ' [preset]' : ''}`" :value="c.id" />
        </el-select>

        <div style="margin-top: 12px; display:flex; gap:8px;">
          <el-button type="danger" @click="removeActiveNode">删除节点</el-button>
          <el-button @click="drawerOpen=false">关闭</el-button>
        </div>
      </div>
      <el-empty v-else description="请选择节点" />
    </el-drawer>

    <el-dialog v-model="mappingDialogOpen" title="选择端口映射" width="520px">
      <div v-if="pendingConnect">
        <div style="color:#909399; font-size:12px; margin-bottom:8px;">
          存在多个可匹配端口组合，请选择本次连线的映射。
        </div>

        <div style="font-weight:600; margin: 8px 0;">From</div>
        <el-select v-model="mappingFromPort" style="width:100%" placeholder="选择输出端口">
          <el-option v-for="p in nodeOutputPorts(pendingConnect.source)" :key="p.name" :label="`${p.name}${p.type ? ' : ' + p.type : ''}`" :value="p.name" />
        </el-select>

        <div style="font-weight:600; margin: 12px 0 8px;">To</div>
        <el-select v-model="mappingToPort" style="width:100%" placeholder="选择输入端口">
          <el-option v-for="p in compatibleInputPorts(pendingConnect.target, pendingConnect.source, mappingFromPort)" :key="p.name" :label="`${p.name}${p.type ? ' : ' + p.type : ''}${p.required ? ' *' : ''}`" :value="p.name" />
        </el-select>
      </div>
      <template #footer>
        <el-button @click="mappingDialogOpen=false">取消</el-button>
        <el-button type="primary" :disabled="!mappingFromPort || !mappingToPort" @click="confirmMapping">确认</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="edgeDrawerOpen" title="连线编辑" size="420px" destroy-on-close>
      <div v-if="activeEdge">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="Edge ID">{{ activeEdge.id }}</el-descriptions-item>
        </el-descriptions>

        <div style="margin-top: 12px; font-weight: 600;">From</div>
        <el-select
          :model-value="activeEdge.source"
          style="width:100%"
          @update:model-value="(v)=> updateActiveEdge({ source: v, sourceHandle: 'out', data: { from_port: '', to_port: activeEdge.data?.to_port || '' } })"
        >
          <el-option v-for="n in vfNodes" :key="n.id" :label="`${n.data?.label || n.data?.node_type} (${n.id})`" :value="n.id" />
        </el-select>
        <el-select
          style="width:100%; margin-top:8px;"
          :disabled="!activeEdge.source"
          :model-value="activeEdge.data?.from_port"
          @update:model-value="(v)=> updateActiveEdge({ data: { ...(activeEdge.data||{}), from_port: v } })"
          placeholder="选择输出端口"
        >
          <el-option v-for="p in nodeOutputPorts(activeEdge.source)" :key="p.name" :label="`${p.name}${p.type ? ' : ' + p.type : ''}`" :value="p.name" />
        </el-select>

        <div style="margin-top: 12px; font-weight: 600;">To</div>
        <el-select
          :model-value="activeEdge.target"
          style="width:100%"
          @update:model-value="(v)=> updateActiveEdge({ target: v, targetHandle: 'in', data: { from_port: activeEdge.data?.from_port || '', to_port: '' } })"
        >
          <el-option v-for="n in vfNodes" :key="n.id" :label="`${n.data?.label || n.data?.node_type} (${n.id})`" :value="n.id" />
        </el-select>
        <el-select
          style="width:100%; margin-top:8px;"
          :disabled="!activeEdge.target"
          :model-value="activeEdge.data?.to_port"
          @update:model-value="(v)=> updateActiveEdge({ data: { ...(activeEdge.data||{}), to_port: v } })"
          placeholder="选择输入端口"
        >
          <el-option
            v-for="p in compatibleInputPorts(activeEdge.target, activeEdge.source, activeEdge.data?.from_port)"
            :key="p.name"
            :label="`${p.name}${p.type ? ' : ' + p.type : ''}${p.required ? ' *' : ''}`"
            :value="p.name"
          />
        </el-select>

        <div style="margin-top: 12px; display:flex; gap:8px;">
          <el-button type="danger" @click="removeActiveEdge">删除连线</el-button>
          <el-button @click="edgeDrawerOpen=false">关闭</el-button>
        </div>
      </div>
      <el-empty v-else description="请选择一条连线" />
    </el-drawer>

  </div>
</template>

<script setup>
import { ref, reactive, onMounted, markRaw } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
// import '@vue-flow/background/dist/style.css';

import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';

import WorkflowNode from '@/components/workflow/WorkflowNode.vue';

import { getNodeTypes, getConfigs } from '@/api/nodeService';
import { listFiles } from '@/api/fileService';
import { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, runWorkflow } from '@/api/workflowService';

const loading = ref(false);
const saving = ref(false);
const running = ref(false);

const palette = ref([]);
const nodeTypesMap = reactive({});
const nodeTypes = { workflowNode: markRaw(WorkflowNode) };
const { project } = useVueFlow() 

const vfNodes = ref([]);
const vfEdges = ref([]);

const configsByType = reactive({});

const workflowList = ref([]);
const selectedWorkflowId = ref('');
const workflowId = ref('');
const workflowName = ref('');
const workflowDesc = ref('');

const firstInputMode = ref('text');
const firstInputText = ref('');
const firstInputFileIds = ref([]);
const initialInputsJson = ref('{}');
const availableFiles = ref([]);

const runResult = ref('');

const drawerOpen = ref(false);
const activeNode = ref(null);

const edgeDrawerOpen = ref(false);
const activeEdge = ref(null);

// 连接时端口映射选择（当存在多个可匹配组合）
const mappingDialogOpen = ref(false);
const pendingConnect = ref(null); // { source, target }
const mappingFromPort = ref('');
const mappingToPort = ref('');

// 连接引导：高亮可连接节点
const connectingSourceId = ref('');

function safeParseJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return null; }
}

function getNodeDef(nodeType) {
  return nodeTypesMap[nodeType] || null;
}

function mkNodeData(nodeType) {
  const def = getNodeDef(nodeType);
  return {
    node_type: nodeType,
    label: def?.name || nodeType,
    inputs: def?.inputs || [],
    outputs: def?.outputs || [],
    config_id: null,
  };
}

function onDragStart(ev, nodeType) {
  ev.dataTransfer.setData('application/x-rag-node', nodeType);
  ev.dataTransfer.effectAllowed = 'move';
}

function onDragOver(ev) {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
}

function addNodeAtCenter(nodeType) {
  const id = Math.random().toString(16).slice(2, 10);
  vfNodes.value.push({
    id,
    type: 'workflowNode',
    position: { x: 80 + Math.random() * 260, y: 80 + Math.random() * 260 },
    data: mkNodeData(nodeType),
  });
}

function onDrop(ev) {
  ev.preventDefault();
  const nodeType = ev.dataTransfer.getData('application/x-rag-node');
  if (!nodeType) return;

  const rect = ev.currentTarget.getBoundingClientRect();
  const position = project({
    x: ev.clientX - rect.left,
    y: ev.clientY - rect.top,
  })

  const id = Math.random().toString(16).slice(2, 10);
  vfNodes.value.push({
    id,
    type: 'workflowNode',
    position: position,
    data: mkNodeData(nodeType),
  });
}

function isTypeCompatible(outType, inType) {
  const a = outType || 'any';
  const b = inType || 'any';
  if (a === 'any' || b === 'any') return true;
  return a === b;
}

function listCompatibleMappings(sourceNodeId, targetNodeId) {
  const s = vfNodes.value.find(n => n.id === sourceNodeId);
  const t = vfNodes.value.find(n => n.id === targetNodeId);
  const outs = s?.data?.outputs || [];
  const ins = t?.data?.inputs || [];

  const mappings = [];
  for (const o of outs) {
    for (const i of ins) {
      if (isTypeCompatible(o.type, i.type)) {
        mappings.push({ from_port: o.name, to_port: i.name });
      }
    }
  }
  return mappings;
}

function isValidConnection(conn) {
  // conn: { source, target, sourceHandle, targetHandle }
  if (!conn?.source || !conn?.target) return true;
  return listCompatibleMappings(conn.source, conn.target).length > 0;
}

function setNodeUiFlag(nodeId, patch) {
  vfNodes.value = vfNodes.value.map(n => {
    if (n.id !== nodeId) return n;
    return { ...n, data: { ...n.data, ui: { ...(n.data?.ui || {}), ...patch } } };
  });
}

function clearConnectUi() {
  vfNodes.value = vfNodes.value.map(n => {
    const ui = n.data?.ui || {};
    const nextUi = { ...ui };
    delete nextUi.dim;
    delete nextUi.connectable;
    return { ...n, data: { ...n.data, ui: nextUi } };
  });
}

function onConnectStart(evt) {
  // 兼容不同事件结构
  const nodeId = evt?.nodeId || evt?.source || evt?.node?.id;
  const handleType = evt?.handleType;
  const handleId = evt?.handleId;
  if (handleType && handleType !== 'source') return;
  if (handleId && handleId !== 'out') return;
  if (!nodeId) return;

  connectingSourceId.value = nodeId;

  const connectable = new Set();
  for (const n of vfNodes.value) {
    if (n.id === nodeId) continue;
    if (listCompatibleMappings(nodeId, n.id).length > 0) connectable.add(n.id);
  }

  vfNodes.value = vfNodes.value.map(n => {
    const ui = n.data?.ui || {};
    const nextUi = { ...ui, dim: false, connectable: false };
    if (n.id === nodeId) {
      nextUi.connectable = true;
    } else if (connectable.has(n.id)) {
      nextUi.connectable = true;
    } else {
      nextUi.dim = true;
    }
    return { ...n, data: { ...n.data, ui: nextUi } };
  });
}

function onConnectEnd() {
  connectingSourceId.value = '';
  clearConnectUi();
}

function pushEdge(source, target, mapping) {
  const id = Math.random().toString(16).slice(2, 12);
  vfEdges.value.push({
    id,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { ...mapping },
    label: `${mapping.from_port} → ${mapping.to_port}`
  });
}

function onConnect(params) {
  const mappings = listCompatibleMappings(params.source, params.target);
  if (mappings.length === 0) {
    ElMessage.warning('无法连线：上游无可匹配输出端口 / 下游无可匹配输入端口（类型不兼容）');
    return;
  }

  // 单一候选：直接连
  if (mappings.length === 1) {
    pushEdge(params.source, params.target, mappings[0]);
    return;
  }

  // 多候选：弹窗选择
  pendingConnect.value = { source: params.source, target: params.target };
  mappingFromPort.value = mappings[0].from_port;
  mappingToPort.value = mappings[0].to_port;
  mappingDialogOpen.value = true;
}

function confirmMapping() {
  if (!pendingConnect.value) return;
  if (!mappingFromPort.value || !mappingToPort.value) return;

  pushEdge(pendingConnect.value.source, pendingConnect.value.target, {
    from_port: mappingFromPort.value,
    to_port: mappingToPort.value
  });

  mappingDialogOpen.value = false;
  pendingConnect.value = null;
}

function onNodeClick(evt) {
  activeNode.value = evt.node;
  drawerOpen.value = true;
}

function onEdgeClick(evt) {
  activeEdge.value = evt.edge;
  edgeDrawerOpen.value = true;
}

function onPaneClick() {
  activeNode.value = null;
  activeEdge.value = null;
}

function onNodesChange() {
  // no-op
}

async function ensureConfigsLoaded(nodeType) {
  if (configsByType[nodeType]) return;
  const res = await getConfigs(nodeType, true);
  if (res.success) configsByType[nodeType] = res.configs;
}

function removeActiveNode() {
  if (!activeNode.value?.id) return;
  const id = activeNode.value.id;
  vfNodes.value = vfNodes.value.filter(n => n.id !== id);
  vfEdges.value = vfEdges.value.filter(e => e.source !== id && e.target !== id);
  drawerOpen.value = false;
  activeNode.value = null;
}

function updateActiveEdge(patch) {
  if (!activeEdge.value?.id) return;
  const id = activeEdge.value.id;
  vfEdges.value = vfEdges.value.map(e => {
    if (e.id !== id) return e;
    const merged = { ...e, ...patch };
    const fp = merged.data?.from_port;
    const tp = merged.data?.to_port;
    if (fp && tp) merged.label = `${fp} → ${tp}`;
    return merged;
  });
  activeEdge.value = vfEdges.value.find(e => e.id === id) || null;
}

function removeActiveEdge() {
  if (!activeEdge.value?.id) return;
  const id = activeEdge.value.id;
  vfEdges.value = vfEdges.value.filter(e => e.id !== id);
  edgeDrawerOpen.value = false;
  activeEdge.value = null;
}

function getNodeById(id) {
  return vfNodes.value.find(n => n.id === id) || null;
}

function nodeOutputPorts(nodeId) {
  const n = getNodeById(nodeId);
  return n?.data?.outputs || [];
}

function nodeInputPorts(nodeId) {
  const n = getNodeById(nodeId);
  return n?.data?.inputs || [];
}

function getPortType(ports, name) {
  return (ports || []).find(p => p.name === name)?.type || 'any';
}

function compatibleInputPorts(targetNodeId, sourceNodeId, fromPortName) {
  const ins = nodeInputPorts(targetNodeId);
  if (!sourceNodeId || !fromPortName) return ins;

  const outs = nodeOutputPorts(sourceNodeId);
  const outType = getPortType(outs, fromPortName);
  return ins.filter(i => isTypeCompatible(outType, i.type));
}

async function refreshAll() {
  loading.value = true;
  try {
    const res = await getNodeTypes();
    if (res.success) {
      palette.value = res.nodes;
      for (const n of res.nodes) nodeTypesMap[n.type] = n;
    }

    const wfRes = await listWorkflows();
    if (wfRes.success) workflowList.value = wfRes.workflows;

    const fr = await listFiles();
    if (fr.success) availableFiles.value = fr.files;
  } finally {
    loading.value = false;
  }
}

function newWorkflow() {
  selectedWorkflowId.value = '';
  workflowId.value = '';
  workflowName.value = '';
  workflowDesc.value = '';
  vfNodes.value = [];
  vfEdges.value = [];
  runResult.value = '';
  firstInputText.value = '';
  firstInputFileIds.value = [];
  initialInputsJson.value = '{}';
}

async function onLoadWorkflow() {
  if (!selectedWorkflowId.value) return;
  const res = await getWorkflow(selectedWorkflowId.value);
  if (!res.success) return;
  const wf = res.workflow;

  workflowId.value = wf.id;
  workflowName.value = wf.name;
  workflowDesc.value = wf.description;

  vfNodes.value = (wf.nodes || []).map(n => ({
    id: n.id,
    type: 'workflowNode',
    position: n.position || { x: 80 + Math.random() * 260, y: 80 + Math.random() * 260 },
    data: {
      ...mkNodeData(n.node_type),
      config_id: n.config_id || null,
    }
  }));

  vfEdges.value = (wf.edges || []).map(e => ({
    id: e.id,
    source: e.from_node_id,
    target: e.to_node_id,
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { from_port: e.from_port, to_port: e.to_port },
    label: `${e.from_port} → ${e.to_port}`
  }));
}

async function onSaveWorkflow() {
  if (!workflowName.value.trim()) {
    ElMessage.warning('请输入工作流名称');
    return;
  }

  const invalidEdge = vfEdges.value.find(e => !e.source || !e.target || !(e.data?.from_port) || !(e.data?.to_port));
  if (invalidEdge) {
    ElMessage.warning('存在不完整连线（未选择端口映射）');
    return;
  }

  saving.value = true;
  try {
    const wf = {
      id: workflowId.value || undefined,
      name: workflowName.value.trim(),
      description: workflowDesc.value,
      nodes: vfNodes.value.map(n => ({
        id: n.id,
        node_type: n.data?.node_type,
        config_id: n.data?.config_id || null,
        position: n.position,
      })),
      edges: vfEdges.value.map(e => ({
        id: e.id,
        from_node_id: e.source,
        from_port: e.data?.from_port,
        to_node_id: e.target,
        to_port: e.data?.to_port,
      })),
    };

    const res = await saveWorkflow(wf);
    if (res.success) {
      workflowId.value = res.workflow.id;
      selectedWorkflowId.value = res.workflow.id;
      ElMessage.success('保存成功');
      const wfRes = await listWorkflows();
      if (wfRes.success) workflowList.value = wfRes.workflows;
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
    const wfRes = await listWorkflows();
    if (wfRes.success) workflowList.value = wfRes.workflows;
  } else {
    ElMessage.error(res.error || '删除失败');
  }
}

function computeInitialInputKeys() {
  const extra = safeParseJson(initialInputsJson.value);
  const keys = new Set(Object.keys((extra && typeof extra === 'object') ? extra : {}));
  if (firstInputMode.value === 'text') keys.add('text');
  if (firstInputMode.value === 'file_ids') keys.add('file_ids');
  return keys;
}

function onValidate() {
  // 清理旧错误标记
  vfNodes.value = vfNodes.value.map(n => {
    const ui = n.data?.ui || {};
    const nextUi = { ...ui };
    delete nextUi.error;
    return { ...n, data: { ...n.data, ui: nextUi } };
  });

  const errors = [];

  // 1) Edge 校验（端口存在 + 类型匹配）
  for (const e of vfEdges.value) {
    const src = vfNodes.value.find(n => n.id === e.source);
    const tgt = vfNodes.value.find(n => n.id === e.target);
    if (!src || !tgt) {
      errors.push({ type: 'edge', id: e.id, error: 'edge source/target 不存在' });
      continue;
    }
    const fp = e.data?.from_port;
    const tp = e.data?.to_port;
    if (!fp || !tp) {
      errors.push({ type: 'edge', id: e.id, error: 'edge 端口映射未设置' });
      continue;
    }
    const out = (src.data?.outputs || []).find(p => p.name === fp);
    const inn = (tgt.data?.inputs || []).find(p => p.name === tp);
    if (!out) errors.push({ type: 'edge', id: e.id, error: `from_port 不存在: ${fp}` });
    if (!inn) errors.push({ type: 'edge', id: e.id, error: `to_port 不存在: ${tp}` });
    if (out && inn && !isTypeCompatible(out.type, inn.type)) {
      errors.push({ type: 'edge', id: e.id, error: `类型不匹配: ${fp}(${out.type||'any'}) -> ${tp}(${inn.type||'any'})` });
    }
  }

  // 2) Required 输入校验
  const initialKeys = computeInitialInputKeys();
  const providedByEdges = new Map(); // nodeId -> Set(port)
  for (const e of vfEdges.value) {
    const tp = e.data?.to_port;
    if (!tp) continue;
    if (!providedByEdges.has(e.target)) providedByEdges.set(e.target, new Set());
    providedByEdges.get(e.target).add(tp);
  }

  for (const n of vfNodes.value) {
    const reqPorts = (n.data?.inputs || []).filter(p => p.required).map(p => p.name);
    const provided = providedByEdges.get(n.id) || new Set();
    const missing = reqPorts.filter(p => !(provided.has(p) || initialKeys.has(p)));
    if (missing.length > 0) {
      errors.push({ type: 'node', id: n.id, error: `缺少必填输入: ${missing.join(', ')}` });
      setNodeUiFlag(n.id, { error: true });
    }
  }

  // 3) 环检测（Kahn）
  const inDeg = new Map(vfNodes.value.map(n => [n.id, 0]));
  const outAdj = new Map(vfNodes.value.map(n => [n.id, []]));
  for (const e of vfEdges.value) {
    if (!inDeg.has(e.target) || !outAdj.has(e.source)) continue;
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    outAdj.get(e.source).push(e.target);
  }
  const q = [];
  for (const [id, d] of inDeg.entries()) if (d === 0) q.push(id);
  const topo = [];
  while (q.length) {
    const id = q.shift();
    topo.push(id);
    for (const nb of outAdj.get(id) || []) {
      inDeg.set(nb, (inDeg.get(nb) || 0) - 1);
      if (inDeg.get(nb) === 0) q.push(nb);
    }
  }
  if (topo.length !== vfNodes.value.length) {
    errors.push({ type: 'graph', error: '存在循环依赖（有环），无法拓扑执行' });
  }

  const ok = errors.length === 0;
  runResult.value = JSON.stringify({ success: ok, errors, topo }, null, 2);
  if (ok) ElMessage.success('检查通过');
  else ElMessage.warning(`检查发现问题：${errors.length} 项（已标红部分节点）`);
}

async function onRun() {
  if (!workflowId.value) {
    ElMessage.warning('请先保存工作流再运行');
    return;
  }
  if (vfNodes.value.length === 0) {
    ElMessage.warning('请先添加节点');
    return;
  }

  const extra = safeParseJson(initialInputsJson.value);
  if (extra === null || typeof extra !== 'object') {
    ElMessage.error('额外 initial_inputs JSON 解析失败');
    return;
  }

  const initialInputs = { ...extra };
  if (firstInputMode.value === 'text') initialInputs.text = firstInputText.value;
  if (firstInputMode.value === 'file_ids') initialInputs.file_ids = firstInputFileIds.value;

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

onMounted(refreshAll);
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
.palette-item .title { font-weight: 600; }
.palette-item .sub { color: #909399; font-size: 12px; }
.flow-wrapper {
  height: 620px;
  border: 1px solid #ebeef5;
  border-radius: 10px;
  overflow: hidden;
}
.flow {
  width: 100%;
  height: 100%;
  background: #fbfcff;
}
</style>
