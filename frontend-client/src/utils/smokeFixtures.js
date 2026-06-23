import { createExecutionTreeState, applyEnvelope, getExecutionTree } from '@ragsystem/agent-sdk-core';
import { legacyStepToEnvelope } from './legacyStepToEnvelope';

export const SMOKE_ARTIFACT_ID = 'viz_smoke_chart';

export const smokeChartArtifact = {
  viz_type: 'chart',
  sub_type: 'line',
  title: 'Smoke 水位趋势',
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
};

const smokeExecutionSteps = [
  {
    kind: 'run',
    phase: 'start',
    step_id: 'smoke-run-1',
    call_id: 'smoke-root',
    round: 1,
    agent_name: 'orchestrator_agent',
    agent_display_name: '编排 Agent',
    status: 'running',
  },
  {
    kind: 'intent',
    phase: 'complete',
    step_id: 'smoke-intent-1',
    call_id: 'smoke-root',
    round: 1,
    agent_name: 'orchestrator_agent',
    agent_display_name: '编排 Agent',
    content: '读取监测数据并生成趋势图。',
    status: 'success',
  },
  {
    kind: 'tool',
    phase: 'start',
    step_id: 'smoke-tool-1',
    parent_step_id: 'smoke-intent-1',
    call_id: 'smoke-create-chart',
    parent_call_id: 'smoke-root',
    round: 1,
    tool_name: 'create_chart',
    arguments: {
      chart_type: 'line',
      x_field: 'time',
      y_field: 'water_level',
    },
    status: 'running',
  },
  {
    kind: 'tool',
    phase: 'end',
    step_id: 'smoke-tool-1',
    parent_step_id: 'smoke-intent-1',
    call_id: 'smoke-create-chart',
    parent_call_id: 'smoke-root',
    round: 1,
    tool_name: 'create_chart',
    status: 'success',
    elapsed_time: 0.42,
    result_preview: `生成可视化产物 ${SMOKE_ARTIFACT_ID}`,
  },
  {
    kind: 'run',
    phase: 'end',
    step_id: 'smoke-run-1',
    call_id: 'smoke-root',
    round: 1,
    agent_name: 'orchestrator_agent',
    agent_display_name: '编排 Agent',
    status: 'success',
  },
];

export function createSmokeArtifactMessages() {
  const execState = createExecutionTreeState();
  for (const env of legacyStepToEnvelope(smokeExecutionSteps)) {
    applyEnvelope(execState, env);
  }
  const executionTree = getExecutionTree(execState);
  const assistant = {
    role: 'assistant',
    id: 'smoke-assistant-1',
    seq: 2,
    content: [
      '这是前端 smoke fixture，用于验证聊天页内联 artifact、右侧产物面板和执行过程布局。',
      '',
      `[viz:${SMOKE_ARTIFACT_ID}]`,
      '',
      '图表下方应继续显示文本内容，移动端和桌面端都不能出现横向溢出。',
    ].join('\n'),
    executionTree,
    showFullSubtasks: false,
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
    _execState: execState,
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
