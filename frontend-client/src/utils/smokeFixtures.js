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
    payload: { phase: 'end', success: true, display_name: '编排 Agent' },
  },
];

export function createSmokeArtifactMessages() {
  const executionTree = buildProtocolExecutionTree(smokeExecutionEvents);
  const assistant = {
    role: 'assistant',
    id: 'smoke-assistant-1',
    seq: 2,
    content: [
      '这是前端 smoke fixture，用于验证聊天页内联 artifact、右侧产物面板和执行过程布局。',
      '',
      `[artifact:${SMOKE_ARTIFACT_ID}]`,
      '',
      '图表下方应继续显示文本内容，移动端和桌面端都不能出现横向溢出。',
    ].join('\n'),
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
