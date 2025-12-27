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
            <el-button size="small" type="success" :disabled="vfNodes.length===0" :loading="running" @click="openRunDialog">运行</el-button>
          </div>
        </el-card>

      </el-col>

      <el-col :span="18">
        <el-card shadow="never" style="margin-bottom: 16px">
          <template #header>
            <div class="card-header">
              <span>全局变量（vars）</span>
              <el-button size="small" @click="addVar">新增变量</el-button>
            </div>
          </template>

          <el-table :data="workflowVars" size="small" style="width:100%" empty-text="暂无变量">
            <el-table-column label="name" min-width="120">
              <template #default="scope">
                <el-input v-model="scope.row.name" placeholder="变量名" />
              </template>
            </el-table-column>
            <el-table-column label="type" width="130">
              <template #default="scope">
                <el-select v-model="scope.row.type" style="width:100%" filterable>
                  <el-option 
                    v-for="t in availableDataTypes" 
                    :key="t.value" 
                    :label="t.label" 
                    :value="t.value" 
                  />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="value" min-width="180">
              <template #default="scope">
                <el-input-number v-if="scope.row.type==='number'" v-model="scope.row.value" style="width:100%" />
                <el-switch v-else-if="scope.row.type==='bool'" v-model="scope.row.value" />
                <!-- 单文件选择器 -->
                <FileSelector
                  v-else-if="scope.row.type==='file_id'"
                  v-model="scope.row.value"
                  :multiple="false"
                  placeholder="选择文件"
                />
                <!-- 多文件选择器 -->
                <FileSelector
                  v-else-if="scope.row.type==='file_ids'"
                  v-model="scope.row.value"
                  :multiple="true"
                  placeholder="选择文件"
                />
                <el-input
                  v-else-if="scope.row.type==='json'"
                  v-model="scope.row.value"
                  type="textarea"
                  :rows="2"
                  placeholder='JSON 字符串，如 {"a":1} 或 ["x"]'
                />
                <el-input v-else v-model="scope.row.value" placeholder="值" />
              </template>
            </el-table-column>
            <el-table-column label="" width="80">
              <template #default="scope">
                <el-button size="small" type="danger" @click="removeVar(scope.$index)">删</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div style="margin-top:8px;color:#909399;font-size:12px;">
            节点输入绑定可引用：var:变量名 或 node:&lt;节点ID&gt;:&lt;输出端口&gt;。
          </div>

          <div style="margin-top: 10px; color:#909399; font-size:12px;">
            运行参数请点击左侧“运行”按钮，在弹出的运行面板中填写（会以 initial_inputs 发送，可覆盖 vars 默认值）。
          </div>
        </el-card>
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

    <el-dialog v-model="runDialogOpen" title="运行工作流" width="760px" destroy-on-close>
      <div style="color:#909399; font-size:12px; margin-bottom:10px;">
        这里填写的是本次运行的 initial_inputs（会覆盖左侧 vars 默认值）；如需保存为默认值，请点“应用为默认值”后再保存工作流。
      </div>

      <div class="run-dialog-body">
        <el-form label-width="140px" size="small">
          <el-form-item v-for="v in (workflowVars || [])" :key="v.name + v.type" :label="`${v.name || '(未命名)'} (${v.type||'any'})`">
            <el-input-number v-if="v.type==='number'" v-model="runForm[v.name]" style="width:100%" />
            <el-switch v-else-if="v.type==='bool'" v-model="runForm[v.name]" />
            <!-- 单文件选择器 -->
            <FileSelector
              v-else-if="v.type==='file_id'"
              v-model="runForm[v.name]"
              :multiple="false"
              placeholder="选择文件"
            />
            <!-- 多文件选择器 -->
            <FileSelector
              v-else-if="v.type==='file_ids'"
              v-model="runForm[v.name]"
              :multiple="true"
              placeholder="选择文件"
            />
            <el-input
              v-else-if="v.type==='json'"
              v-model="runForm[v.name]"
              type="textarea"
              :rows="4"
              placeholder='请输入 JSON 字符串'
            />
            <el-input v-else v-model="runForm[v.name]" placeholder="请输入值" />
          </el-form-item>

          <el-collapse>
            <el-collapse-item title="预览：最终 initial_inputs" name="preview">
              <el-input :model-value="runPreviewText" type="textarea" :rows="7" readonly />
              <div style="margin-top:6px;color:#909399;font-size:12px;">
                预览会实时解析 JSON；若提示解析失败，请先修正对应变量或高级 JSON。
              </div>
            </el-collapse-item>

            <el-collapse-item title="高级：额外 initial_inputs JSON（可选）" name="adv">
              <el-input v-model="runExtraJson" type="textarea" :rows="4" placeholder='例如：{"text":"..."}' />
            </el-collapse-item>
          </el-collapse>
        </el-form>
      </div>

      <template #footer>
        <el-button @click="runDialogOpen=false">取消</el-button>
        <el-button :disabled="running" @click="applyRunToVars">应用为默认值</el-button>
        <el-button type="primary" :loading="running" @click="doRun">运行</el-button>
      </template>
    </el-dialog>

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

        <div style="margin-top: 14px; font-weight:600;">输入绑定（Bindings）</div>
        <div style="color:#909399;font-size:12px;margin:6px 0 8px;">
          先连线 A→B，再在 B 的输入端口选择引用 A 的输出变量；也可选择全局 var。
        </div>

        <el-form label-width="110px" size="small">
          <el-form-item v-for="p in (activeNode.data.inputs || [])" :key="p.name" :label="p.name + (p.required ? ' *' : '')">
            <el-select
              style="width:100%"
              :model-value="(activeNode.data.input_bindings || {})[p.name] || ''"
              @update:model-value="(v)=> setInputBinding(activeNode.id, p.name, v)"
              placeholder="选择来源"
              clearable
            >
              <el-option label="(空)" value="" />
              <el-option-group label="全局变量 vars">
                <el-option
                  v-for="opt in varOptionsForInput(p)"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-option-group>
              <el-option-group label="上游节点输出">
                <el-option
                  v-for="opt in upstreamOptionsForInput(activeNode.id, p)"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-option-group>
            </el-select>
          </el-form-item>
        </el-form>

        <div style="margin-top: 12px; display:flex; gap:8px;">
          <el-button type="danger" @click="removeActiveNode">删除节点</el-button>
          <el-button @click="drawerOpen=false">关闭</el-button>
        </div>
      </div>
      <el-empty v-else description="请选择节点" />
    </el-drawer>


    <el-drawer v-model="edgeDrawerOpen" title="连线" size="420px" destroy-on-close>
      <div v-if="activeEdge">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="Edge ID">{{ activeEdge.id }}</el-descriptions-item>
          <el-descriptions-item label="From">{{ activeEdge.source }}</el-descriptions-item>
          <el-descriptions-item label="To">{{ activeEdge.target }}</el-descriptions-item>
        </el-descriptions>

        <div style="margin-top: 12px; color:#909399; font-size:12px;">
          端口映射不在边上配置；请到目标节点“输入绑定”里选择来自上游节点输出或全局变量。
        </div>

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
import { ref, reactive, onMounted, markRaw, computed } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import '@vue-flow/core/dist/style.css';
import '@vue-flow/controls/dist/style.css';
// import '@vue-flow/background/dist/style.css';

import { VueFlow, useVueFlow } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';

import WorkflowNode from '@/components/workflow/WorkflowNode.vue';
import FileSelector from '@/components/FileSelector.vue';

import { getNodeTypes, getConfigs, getDataTypes } from '@/api/nodeService';
import { listFiles } from '@/api/fileService';
import { listWorkflows, getWorkflow, saveWorkflow, deleteWorkflow, runWorkflow } from '@/api/workflowService';

defineOptions({ name: 'WorkflowBuilderView' });

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

const availableFiles = ref([]);

const runDialogOpen = ref(false);
const runForm = reactive({});
const runExtraJson = ref('{}');

const runResult = ref('');

const drawerOpen = ref(false);
const activeNode = ref(null);

const edgeDrawerOpen = ref(false);
const activeEdge = ref(null);

// 全局变量（替代在边上配置端口映射）
const workflowVars = ref([]); // [{ name, type, value }]

// 可用的数据类型（动态从后端加载）
const availableDataTypes = ref([
  // 默认类型（后端加载前的初始值）
  { label: 'any', value: 'any' },
  { label: 'text', value: 'text' },
  { label: 'string', value: 'string' },
  { label: 'integer', value: 'integer' },
  { label: 'number', value: 'number' },
  { label: 'bool', value: 'bool' },
  { label: 'json', value: 'json' }
]);

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

function onConnect(params) {
  const mappings = listCompatibleMappings(params.source, params.target);
  if (mappings.length === 0) {
    ElMessage.warning('无法连线：上游无可匹配输出端口 / 下游无可匹配输入端口（类型不兼容）');
    return;
  }

  const id = Math.random().toString(16).slice(2, 12);
  vfEdges.value.push({
    id,
    source: params.source,
    target: params.target,
    sourceHandle: 'out',
    targetHandle: 'in',
  });
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

function addVar() {
  workflowVars.value.push({ name: '', type: 'any', value: '' });
}

function removeVar(index) {
  workflowVars.value.splice(index, 1);
}

function setInputBinding(nodeId, inputPortName, ref) {
  vfNodes.value = vfNodes.value.map(n => {
    if (n.id !== nodeId) return n;
    const next = { ...(n.data?.input_bindings || {}) };
    if (!ref) delete next[inputPortName];
    else next[inputPortName] = ref;
    return { ...n, data: { ...n.data, input_bindings: next } };
  });

  if (activeNode.value?.id === nodeId) {
    activeNode.value = vfNodes.value.find(n => n.id === nodeId) || activeNode.value;
  }
}

function varOptionsForInput(inputPort) {
  const inType = inputPort?.type || 'any';
  return (workflowVars.value || [])
    .filter(v => v?.name)
    .filter(v => isTypeCompatible(v.type || 'any', inType))
    .map(v => ({
      label: `${v.name} (${v.type || 'any'})`,
      value: `var:${v.name}`
    }));
}

function upstreamOptionsForInput(targetNodeId, inputPort) {
  const inType = inputPort?.type || 'any';
  const upstreamIds = Array.from(new Set((vfEdges.value || []).filter(e => e.target === targetNodeId).map(e => e.source)));

  const opts = [];
  for (const uid of upstreamIds) {
    const up = getNodeById(uid);
    if (!up) continue;
    for (const out of (up.data?.outputs || [])) {
      if (!isTypeCompatible(out.type || 'any', inType)) continue;
      opts.push({
        label: `${up.data?.label || up.data?.node_type}(${uid}).${out.name}`,
        value: `node:${uid}:${out.name}`
      });
    }
  }
  return opts;
}

async function loadDataTypes() {
  try {
    const res = await getDataTypes();
    if (res.success) {
      const types = res.data.types;
      availableDataTypes.value = types.map(t => ({ label: t, value: t }));
      console.log('✅ 动态加载数据类型:', types.length, '种', types);
    }
  } catch (error) {
    console.error('加载数据类型失败:', error);
    // 保留默认类型
  }
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
    
    // 动态加载数据类型
    await loadDataTypes();
  } finally {
    loading.value = false;
  }
}

function newWorkflow() {
  selectedWorkflowId.value = '';
  workflowId.value = '';
  workflowName.value = '';
  workflowDesc.value = '';
  workflowVars.value = [];
  vfNodes.value = [];
  vfEdges.value = [];
  runResult.value = '';
  runExtraJson.value = '{}';
  Object.keys(runForm).forEach(k => delete runForm[k]);
}

async function onLoadWorkflow() {
  if (!selectedWorkflowId.value) return;
  const res = await getWorkflow(selectedWorkflowId.value);
  if (!res.success) return;
  const wf = res.workflow;

  workflowId.value = wf.id;
  workflowName.value = wf.name;
  workflowDesc.value = wf.description;
  workflowVars.value = (wf.variables || []).map(v => ({
    name: v.name,
    type: v.type || 'any',
    value: (v.value ?? '')
  }));

  vfNodes.value = (wf.nodes || []).map(n => ({
    id: n.id,
    type: 'workflowNode',
    position: n.position || { x: 80 + Math.random() * 260, y: 80 + Math.random() * 260 },
    data: {
      ...mkNodeData(n.node_type),
      config_id: n.config_id || null,
    }
  }));

  // 连接边（link）：不保存端口映射；端口映射在节点 input_bindings 中配置
  vfEdges.value = (wf.edges || []).map(e => ({
    id: e.id,
    source: e.from_node_id,
    target: e.to_node_id,
    sourceHandle: 'out',
    targetHandle: 'in',
  }));

  // 载入节点 input_bindings
  const nodeById = new Map(vfNodes.value.map(n => [n.id, n]));
  for (const n of (wf.nodes || [])) {
    const vn = nodeById.get(n.id);
    if (!vn) continue;
    if (n.input_bindings) vn.data.input_bindings = { ...(n.input_bindings || {}) };
  }

  // 兼容旧工作流：若边上带端口映射，自动转为目标节点的 input_bindings
  for (const e of (wf.edges || [])) {
    if (!e.from_port || !e.to_port) continue;
    const tgt = nodeById.get(e.to_node_id);
    if (!tgt) continue;
    tgt.data.input_bindings = { ...(tgt.data.input_bindings || {}), [e.to_port]: `node:${e.from_node_id}:${e.from_port}` };
  }
}

async function onSaveWorkflow() {
  if (!workflowName.value.trim()) {
    ElMessage.warning('请输入工作流名称');
    return;
  }

  const invalidEdge = vfEdges.value.find(e => !e.source || !e.target);
  if (invalidEdge) {
    ElMessage.warning('存在不完整连线');
    return;
  }

  saving.value = true;
  try {
    const wf = {
      id: workflowId.value || undefined,
      name: workflowName.value.trim(),
      description: workflowDesc.value,
      variables: workflowVars.value,
      nodes: vfNodes.value.map(n => ({
        id: n.id,
        node_type: n.data?.node_type,
        config_id: n.data?.config_id || null,
        position: n.position,
        input_bindings: n.data?.input_bindings || null,
      })),
      edges: vfEdges.value.map(e => ({
        id: e.id,
        from_node_id: e.source,
        from_port: null,
        to_node_id: e.target,
        to_port: null,
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

function getVarByName(name) {
  return (workflowVars.value || []).find(v => v && v.name === name) || null;
}

function normalizeVarDefaultForRun(v) {
  const t = v?.type || 'any';
  const raw = v?.value;
  if (t === 'number') return (raw === '' || raw === null || raw === undefined) ? undefined : Number(raw);
  if (t === 'bool') return raw === true || raw === false ? raw : (String(raw).toLowerCase() === 'true');
  if (t === 'file_id') return raw || '';
  if (t === 'file_ids') return Array.isArray(raw) ? raw : (raw ? raw : []);
  if (t === 'json') {
    if (typeof raw === 'string') return raw;
    if (raw === null || raw === undefined || raw === '') return '';
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  }
  return raw ?? '';
}

function buildRunInitialInputs() {
  const obj = {};
  for (const v of (workflowVars.value || [])) {
    if (!v?.name) continue;
    const t = v.type || 'any';
    let val = runForm[v.name];

    if (t === 'number') {
      if (val === '' || val === null || val === undefined) continue;
      const n = Number(val);
      if (!Number.isFinite(n)) {
        throw new Error(`变量 ${v.name} 不是合法 number`);
      }
      val = n;
    }

    if (t === 'json') {
      if (val === '' || val === null || val === undefined) continue;
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch { throw new Error(`变量 ${v.name} JSON 解析失败`); }
      }
    }

    if (t === 'file_id') {
      if (val === '' || val === null || val === undefined) continue;
      // file_id 保持为字符串
    }

    if (t === 'file_ids') {
      if (!Array.isArray(val)) val = val ? [val] : [];
    }

    obj[v.name] = val;
  }

  const extra = safeParseJson(runExtraJson.value);
  if (runExtraJson.value && extra === null) throw new Error('额外 initial_inputs JSON 解析失败');
  if (extra && typeof extra === 'object') Object.assign(obj, extra);
  return obj;
}

function computeInitialInputKeys() {
  return new Set((workflowVars.value || []).map(v => v?.name).filter(Boolean));
}

function parseBinding(ref) {
  if (!ref) return null;
  if (ref.startsWith('var:')) return { kind: 'var', name: ref.slice(4) };
  if (ref.startsWith('node:')) {
    const parts = ref.split(':', 3);
    if (parts.length === 3) return { kind: 'node', nodeId: parts[1], port: parts[2] };
  }
  return null;
}

function hasLink(fromId, toId) {
  return (vfEdges.value || []).some(e => e.source === fromId && e.target === toId);
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

  // 1) Link 校验（source/target存在 + 至少存在一组可匹配端口）
  for (const e of vfEdges.value) {
    const src = vfNodes.value.find(n => n.id === e.source);
    const tgt = vfNodes.value.find(n => n.id === e.target);
    if (!src || !tgt) {
      errors.push({ type: 'edge', id: e.id, error: 'edge source/target 不存在' });
      continue;
    }
    const ok = listCompatibleMappings(e.source, e.target).length > 0;
    if (!ok) errors.push({ type: 'edge', id: e.id, error: '该连线两端不存在任何可兼容端口组合（类型不兼容）' });
  }

  // 2) Required 输入校验（bindings + vars/initial_inputs）
  const initialKeys = computeInitialInputKeys();

  for (const n of vfNodes.value) {
    const bindings = n.data?.input_bindings || {};
    const reqPorts = (n.data?.inputs || []).filter(p => p.required);

    for (const p of reqPorts) {
      const ref = bindings[p.name];
      if (!ref) {
        if (!initialKeys.has(p.name)) {
          errors.push({ type: 'node', id: n.id, error: `缺少必填输入: ${p.name}` });
          setNodeUiFlag(n.id, { error: true });
        }
        continue;
      }

      const b = parseBinding(ref);
      if (!b) {
        errors.push({ type: 'node', id: n.id, error: `输入绑定格式无效: ${p.name}=${ref}` });
        setNodeUiFlag(n.id, { error: true });
        continue;
      }

      if (b.kind === 'var') {
        if (!getVarByName(b.name) && !initialKeys.has(b.name)) {
          errors.push({ type: 'node', id: n.id, error: `绑定的变量不存在: ${b.name}` });
          setNodeUiFlag(n.id, { error: true });
        }
      }

      if (b.kind === 'node') {
        if (!hasLink(b.nodeId, n.id)) {
          errors.push({ type: 'node', id: n.id, error: `绑定引用未建立连线: ${b.nodeId} -> ${n.id}` });
          setNodeUiFlag(n.id, { error: true });
        }
      }
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

function openRunDialog() {
  if (!workflowId.value) {
    ElMessage.warning('请先保存工作流再运行');
    return;
  }
  if (vfNodes.value.length === 0) {
    ElMessage.warning('请先添加节点');
    return;
  }

  // 用当前 vars 默认值填充运行面板（可在运行时覆盖）
  Object.keys(runForm).forEach(k => delete runForm[k]);
  for (const v of (workflowVars.value || [])) {
    if (!v?.name) continue;
    runForm[v.name] = normalizeVarDefaultForRun(v);
  }

  runDialogOpen.value = true;
}

function tryBuildRunInitialInputs() {
  try {
    return { ok: true, data: buildRunInitialInputs() };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const runPreviewText = computed(() => {
  const r = tryBuildRunInitialInputs();
  if (!r.ok) return `参数错误：${r.error}`;
  try { return JSON.stringify(r.data, null, 2); } catch { return String(r.data); }
});

function applyRunToVars() {
  // 回写 vars 的默认值（不自动保存；用户可再点“保存”）
  for (const v of (workflowVars.value || [])) {
    if (!v?.name) continue;
    const t = v.type || 'any';
    const val = runForm[v.name];

    if (t === 'number') {
      if (val === '' || val === null || val === undefined) { v.value = ''; continue; }
      const n = Number(val);
      if (!Number.isFinite(n)) { ElMessage.error(`变量 ${v.name} 不是合法 number`); return; }
      v.value = n;
      continue;
    }

    if (t === 'bool') {
      v.value = Boolean(val);
      continue;
    }

    if (t === 'file_id') {
      v.value = val || '';
      continue;
    }

    if (t === 'file_ids') {
      v.value = Array.isArray(val) ? val : (val ? [val] : []);
      continue;
    }

    if (t === 'json') {
      // 保存为字符串，保持用户输入（后端运行时会解析）
      v.value = (val === null || val === undefined) ? '' : String(val);
      continue;
    }

    v.value = val;
  }

  ElMessage.success('已应用到 vars（请记得点击“保存”）');
  runDialogOpen.value = false;
}

async function doRun() {
  let initialInputs;
  try {
    initialInputs = buildRunInitialInputs();
  } catch (e) {
    ElMessage.error(e.message || '运行参数解析失败');
    return;
  }

  running.value = true;
  try {
    const res = await runWorkflow(workflowId.value, initialInputs);
    runResult.value = JSON.stringify(res, null, 2);
    if (res.success) {
      ElMessage.success('运行完成');
      runDialogOpen.value = false;
    } else {
      ElMessage.error(res.error || '运行失败');
    }
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

.run-dialog-body {
  max-height: 60vh;
  overflow: auto;
  padding-right: 8px;
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
