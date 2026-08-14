import { buildExecutionTree as buildProtocolExecutionTree } from '@ragsystem/agent-protocol';

export const SMOKE_ARTIFACT_ID = 'art_smoke_chart';

export const smokeChartArtifact = {
  schema_version: 2,
  artifact_id: SMOKE_ARTIFACT_ID,
  revision: 1,
  session_id: 'smoke-artifact-session',
  kind: 'chart.echarts',
  subtype: 'line',
  title: 'Smoke 水位趋势',
  status: 'ready',
  assets: [],
  presentations: [{
    presentation_id: 'primary',
    surface: 'chart',
    renderer: 'chart.echarts',
    assets: {},
    config: {
    title: {
      text: 'Smoke 水位趋势',
      left: 'center',
    },
    tooltip: {
      trigger: 'axis',
    },
    legend: {
      top: 28,
      data: ['水位', '警戒线'],
    },
    grid: {
      left: 48,
      right: 24,
      top: 72,
      bottom: 48,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: ['08:00', '10:00', '12:00', '14:00', '16:00'],
    },
    yAxis: {
      type: 'value',
      name: 'm',
      min: 10,
    },
    dataZoom: [
      {
        type: 'inside',
        start: 0,
        end: 100,
      },
      {
        type: 'slider',
        height: 18,
        bottom: 14,
      },
    ],
    series: [
      {
        name: '水位',
        type: 'line',
        smooth: true,
        symbolSize: 8,
        data: [10.8, 11.4, 12.3, 12.9, 12.1],
      },
      {
        name: '警戒线',
        type: 'line',
        symbol: 'none',
        lineStyle: {
          type: 'dashed',
        },
        data: [12, 12, 12, 12, 12],
      },
    ],
    },
  }],
  metadata: {},
  provenance: {},
  relations: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const smokeExecutionEvents = [
  {
    type: 'agent_started',
    session_id: 'smoke-session',
    call_id: 'smoke-root',
    agent_id: 'orchestrator_agent',
    payload: { phase: 'start', display_name: '编排 Agent' },
  },
  {
    type: 'stream_output',
    session_id: 'smoke-session',
    run_id: 'smoke-run',
    call_id: 'smoke-root',
    agent_id: 'orchestrator_agent',
    payload: { phase: 'intent_complete', round: 1, content: '读取监测数据并生成趋势图。' },
  },
  {
    type: 'tool_call',
    session_id: 'smoke-session',
    call_id: 'smoke-create-chart',
    agent_id: 'orchestrator_agent',
    payload: {
      phase: 'start',
      tool: 'create_chart',
      round: 1,
      input: { chart_type: 'line', x_field: 'time', y_field: 'water_level' },
      lineage: { parent_call_id: 'smoke-root' },
    },
  },
  {
    type: 'tool_result',
    session_id: 'smoke-session',
    call_id: 'smoke-create-chart',
    agent_id: 'orchestrator_agent',
    payload: {
      phase: 'end',
      tool: 'create_chart',
      ok: true,
      elapsed_ms: 420,
      observation: `生成可视化产物 ${SMOKE_ARTIFACT_ID}`,
      lineage: { parent_call_id: 'smoke-root' },
    },
  },
  {
    type: 'agent_ended',
    session_id: 'smoke-session',
    call_id: 'smoke-root',
    agent_id: 'orchestrator_agent',
    payload: { phase: 'end', success: true, status: 'succeeded', display_name: '编排 Agent' },
  },
];

export function createSmokeArtifactMessages() {
  const executionTree = buildProtocolExecutionTree(smokeExecutionEvents);
  const assistant = {
    role: 'assistant',
    id: 'smoke-assistant-1',
    seq: 2,
    content: '这是前端 smoke fixture，用于验证聊天页内联产物和按需运行中心布局。',
    content_parts: [
      { type: 'text', text: '这是前端 smoke fixture，用于验证聊天页内联产物和按需运行中心布局。' },
      {
        type: 'file_ref',
        file_path: 'results/water-level-report.csv',
        presentation: 'attachment',
        caption: '水位趋势数据',
      },
      { type: 'text', text: '产物下方应继续显示文本内容，移动端和桌面端都不能出现横向溢出。' },
    ],
    executionTree,
    status: [],
    finished: true,
    stopped: false,
    has_execution: true,
    executionStepsLoaded: true,
    executionStepsLoading: false,
    executionStepsLoadError: '',
    run_id: 'smoke-run',
    metadata: {
      run_id: 'smoke-run',
      execution_time: 1.36,
      first_token_time: 0.28,
    },
    _execState: null,
  };

  return [
    {
      role: 'user',
      id: 'smoke-user-1',
      seq: 1,
      content: '生成一张水位趋势图，并展示执行过程。',
      attachments: [],
      metadata: {},
    },
    assistant,
  ];
}

/**
 * pending-image 冒烟：带图发送后待落库的"幽灵气泡"（图片识别进度展示）。
 * 历史消息 fixture；附件与识别事件由 armSmokePendingImageSend 装配。
 */
export function createSmokePendingImageMessages() {
  return [
    {
      role: 'user',
      id: 'smoke-pending-user-1',
      seq: 1,
      content: '这是我们的监测点位布设方案，先熟悉一下。',
      attachments: [],
      metadata: {},
    },
    {
      role: 'assistant',
      id: 'smoke-pending-assistant-1',
      seq: 2,
      content: '已了解布设方案。后续把现场照片发我即可，我会结合方案做对比分析。',
      content_parts: [{ type: 'text', text: '已了解布设方案。后续把现场照片发我即可，我会结合方案做对比分析。' }],
      executionTree: { root: null, steps: [] },
      status: [],
      finished: true,
      stopped: false,
      has_execution: false,
      executionStepsLoaded: false,
      executionStepsLoading: false,
      executionStepsLoadError: '',
      metadata: {},
      _execState: null,
    },
  ];
}

/** 生成两张 canvas 本地图片附件（幽灵气泡缩略图用，颜色区分）。 */
export async function createSmokePendingImageAttachments() {
  const makeFile = async (name, color, label) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = '24px sans-serif';
    ctx.fillText(label, 20, 104);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return new File([blob], name, { type: 'image/png' });
  };
  const specs = [
    ['现场照片-上游.png', '#4f8cff', '上游断面'],
    ['现场照片-下游.png', '#22a05a', '下游断面'],
  ];
  const attachments = [];
  for (const [name, color, label] of specs) {
    const file = await makeFile(name, color, label);
    attachments.push({
      source: 'local',
      local_id: `smoke-pending-${name}`,
      file,
      original_name: name,
      stored_name: name,
      mime: 'image/png',
      size: file.size,
      kind: 'image',
      preview_url: '',
    });
  }
  return attachments;
}

/**
 * 注入带图发送待落库的幽灵气泡与识别进度事件（__smoke=pending-image）。
 * @param {'sending' | 'recognizing' | 'done'} phase
 *   sending：仅捕获快照；recognizing：识别中且第一张已完成；done：识别完成待落库。
 */
export async function armSmokePendingImageSend(phase = 'recognizing') {
  const [{ capturePendingImageSend }, { handlePluginEventPayload }] = await Promise.all([
    import('../composables/usePendingImageSend.js'),
    import('../composables/usePluginEvents.js'),
  ]);
  const attachments = await createSmokePendingImageAttachments();
  capturePendingImageSend({ content: '帮我对比这两张现场照片的水位变化', attachments });
  if (phase === 'sending') return;

  const emit = (event, data) => handlePluginEventPayload({
    plugin_id: '@ragsystem/backend-plugin-image-tools',
    event,
    data,
    delivery: 'ephemeral',
  });
  emit('image.describe_started', { source: 'message', total: 2, files: ['现场照片-上游.png', '现场照片-下游.png'] });
  emit('image.describe_progress', { source: 'message', file_id: 'smoke-f1', name: '现场照片-上游.png', index: 0, total: 2, ok: true });
  if (phase === 'done') {
    emit('image.describe_progress', { source: 'message', file_id: 'smoke-f2', name: '现场照片-下游.png', index: 1, total: 2, ok: true });
    emit('image.describe_completed', { source: 'message', total: 2, described: 2, failed: 0, duration_ms: 1600 });
  }
}
