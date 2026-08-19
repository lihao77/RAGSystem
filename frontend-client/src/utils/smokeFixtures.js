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

/* ============================================================================
 * file_ref presentation 冒烟（?__smoke=fileref）
 * 覆盖 inline / preview / attachment × 常见文件类别的渲染矩阵；
 * 工作区文件内容统一由 scripts/screenshot-smoke.mjs 通过 CDP 网络层拦截供给
 * （SMOKE_FILE_REF_FILES 为两侧共享的数据源）。
 * ========================================================================== */

const SMOKE_PNG_PHOTO = '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';
const SMOKE_PNG_MAP = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAADrElEQVR42u3Tt1EDMBQAUE+impwq1ZrAYPJMZANzaAqTQ0VOo7CDfuPTvbu3whvMHAyJeKmJiEnJNBsYKLDAAguMwAILLDACCyywwAgssMACI7DAAguMwAILLDACCzwlgWcP14l4rYmIq5JpJrDAAgssMAILLLDACCywwAIjsMACC4zAAgssMAILLLDACCywwAIjsMACCywwAgsssMAILLDAAiOwwAILjMACCywwAgsssMAILLDAvQSeO9og4q0mIq5LppnAAgsssMAILLDAAiOwwAILjMACCywwAgsssMAILLDAAiOwwAILjMACCyywwAgssMACI7DAAguMwAILLDACCyywwAgssMACI7DAAvcSeP54RMR7TUTclEwzgQUWWGCBEVhggQVGYIEFFhiBBRZYYAQWWGCBEVhggQVGYIEFFhiBBRZYYIERWGCBBUZggQUWGIEFFlhgBBZYYIERWGCBBUZggQXuJfDCySYRHzURcVsyzQQWWGCBBUZggQUWGIEFFlhgBBZYYIERWGCBBUZggQUWGIEFFlhgBBZYYIEFRmCBBRYYgQUWWGAEFlhggRFYYIEFRmCBBRYYgQUWuJfAi6dbRHzWRMRdyTQTWGCBBRYYgQUWWGAEFlhggRFYYIEFRmCBBRYYgQUWWGAEFlhggRFYYIEFFhiBBRZYYAQWWGCBEVhggQVGYIEFFhiBBRZYYAQWWOBeAi+dbRPxVRMR9yXTTGCBBRZYYAQWWGCBEVhggQVGYIEFFhiBBRZYYAQWWGCBEVhggQVGYIEFFlhgBBZYYIERWGCBBUZggQUWGIEFFlhgBBZYYIERWGCBewm8PN4h4rsmIh5KppnAAgsssMAILLDAAiOwwAILjMACCywwAgsssMAILLDAAiOwwAILjMACCyywwAgssMACI7DAAguMwAILLDACCyywwAgssMACI7DAAvcSeOV8l4ifmoh4LJlmAgsssMACI7DAAguMwAILLDACCyywwAgssMACI7DAAguMwAILLDACCyywwAIjsMACC4zAAgssMAILLLDACCywwAIjsMACC4zAAgvcS+DViz0ifmsi4qlkmgkssMACC4zAAgssMAILLLDACCywwAIjsMACC4zAAgssMAILLLDACCywwAILjMACCywwAgsssMAILLDAAiOwwAILjMACCywwAgsscC+B1y73ifiriYjnkmkmsMACCywwAgsssMAILLDAAiOwwAILjMACCywwAgsssMAILPCU+Ac0bck07+TTGQAAAABJRU5ErkJggg==';

function buildSmokePdf(title) {
  const escape = (value) => value.replace(/([()\\])/g, '\\$1');
  const stream = [
    `BT /F1 16 Tf 24 160 Td (${escape(title)}) Tj ET`,
    'BT /F1 11 Tf 24 130 Td (Generated by frontend smoke fixture to verify) Tj ET',
    'BT /F1 11 Tf 24 114 Td (file_ref presentation="preview" rendering.) Tj ET',
  ].join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return pdf;
}

const csvRows = (count) => Array.from({ length: count }, (_, index) => {
  const hour = String(8 + index).padStart(2, '0');
  return `${hour}:00,站点-${index + 1},${(10 + index * 0.4).toFixed(2)},${(11.5 + index * 0.2).toFixed(2)}`;
});

/** 冒烟工作区文件表：path → { body, contentType, base64? } */
export const SMOKE_FILE_REF_FILES = {
  'assets/site-photo.png': { body: SMOKE_PNG_PHOTO, contentType: 'image/png', base64: true },
  'assets/warning-map.png': { body: SMOKE_PNG_MAP, contentType: 'image/png', base64: true },
  'results/summary.md': {
    // 对齐后端 inferMimeType 的真实返回（.md → text/plain），保持冒烟链路保真
    contentType: 'text/plain',
    body: [
      '# 监测周报（摘要）',
      '',
      '本周共回收 **3 个站点** 的水位数据，整体趋势平稳。',
      '',
      '## 关键指标',
      '',
      '| 站点 | 平均水位 | 警戒线 |',
      '| --- | --- | --- |',
      '| 站点-1 | 10.80 m | 12.00 m |',
      '| 站点-2 | 11.40 m | 12.00 m |',
      '| 站点-3 | 12.30 m | 12.00 m |',
      '',
      '## 计算口径',
      '',
      '```python',
      'mean_level = sum(levels) / len(levels)',
      '```',
    ].join('\n'),
  },
  'data/water-level.csv': {
    contentType: 'text/csv',
    body: ['time,station,level,warn'].concat(csvRows(15)).join('\n'),
  },
  'data/metrics.json': {
    contentType: 'application/json',
    body: JSON.stringify({
      generated_at: '2026-08-19T08:00:00Z',
      station_count: 3,
      summary: { mean_level: 11.5, max_level: 12.9, warn_threshold: 12.0 },
      stations: [
        { id: 'ST-01', name: '站点-1', level: 10.8 },
        { id: 'ST-02', name: '站点-2', level: 11.4 },
        { id: 'ST-03', name: '站点-3', level: 12.3 },
      ],
    }, null, 2),
  },
  'scripts/analyze.py': {
    contentType: 'text/x-python',
    body: [
      '"""水位数据分析脚本（冒烟样例）。"""',
      'from statistics import mean',
      '',
      'WARN_THRESHOLD = 12.0',
      '',
      'def analyze(levels):',
      '    """返回均值与超警列表。"""',
      '    avg = mean(levels)',
      '    over = [v for v in levels if v > WARN_THRESHOLD]',
      '    return avg, over',
      '',
      'if __name__ == "__main__":',
      '    avg, over = analyze([10.8, 11.4, 12.3, 12.9, 12.1])',
      '    print(f"平均水位 {avg:.2f} m，超警 {len(over)} 项")',
    ].join('\n'),
  },
  'report/final-report.pdf': {
    contentType: 'application/pdf',
    body: buildSmokePdf('Smoke PDF Preview OK'),
  },
  'site/dashboard.html': {
    contentType: 'text/html',
    body: [
      '<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title></head>',
      '<body style="font-family:sans-serif;margin:40px;color:#1a2b4a">',
      '<h2>站点水位看板</h2><p>file_ref presentation="preview" 的 HTML 样例（sandbox iframe 渲染）。</p>',
      '<ul><li>站点-1：10.80 m</li><li>站点-2：11.40 m</li><li>站点-3：12.30 m</li></ul>',
      '</body></html>',
    ].join('\n'),
  },
  'data/raw-export.csv': {
    contentType: 'text/csv',
    body: ['record_id,payload'].concat(Array.from({ length: 5 }, (_, i) => `${i + 1},"原始导出数据行 ${i + 1}"`)).join('\n'),
  },
};

/** file_ref 冒烟消息：覆盖 presentation × category 矩阵（文件内容由 screenshot-smoke 在网络层供给）。 */
export function createSmokeFileRefMessages() {
  const assistant = {
    role: 'assistant',
    id: 'smoke-fileref-assistant-1',
    seq: 2,
    content: '本条消息验证 file_ref 三种 presentation 的渲染矩阵。',
    content_parts: [
      { type: 'text', text: '本条消息验证 file_ref 三种 presentation 的渲染矩阵：图片走内联/缩略图 + lightbox，文档类 inline 直接渲染、preview 点击放大、attachment 仅提供下载。' },
      { type: 'file_ref', file_path: 'assets/site-photo.png', presentation: 'inline', caption: '站点实拍（inline 内联图）' },
      { type: 'file_ref', file_path: 'assets/warning-map.png', presentation: 'preview', caption: '预警分布图（preview 缩略图）' },
      { type: 'file_ref', file_path: 'results/summary.md', presentation: 'inline', caption: '监测周报摘要（inline Markdown）' },
      { type: 'file_ref', file_path: 'data/water-level.csv', presentation: 'inline', caption: '水位序列（inline 表格）' },
      { type: 'file_ref', file_path: 'scripts/analyze.py', presentation: 'inline', caption: '分析脚本（inline 代码块）' },
      { type: 'file_ref', file_path: 'data/metrics.json', presentation: 'preview', caption: '指标汇总（preview JSON）' },
      { type: 'file_ref', file_path: 'report/final-report.pdf', presentation: 'preview', caption: '正式周报（preview PDF）' },
      { type: 'file_ref', file_path: 'site/dashboard.html', presentation: 'preview', caption: '看板页面（preview HTML）' },
      { type: 'file_ref', file_path: 'data/raw-export.csv', presentation: 'attachment', caption: '原始导出（attachment 下载卡片）' },
      { type: 'text', text: '以上产物均来自冒烟夹具，验证完渲染矩阵后可回到正常会话。' },
    ],
    status: [],
    finished: true,
    stopped: false,
    has_execution: false,
    executionStepsLoaded: true,
    executionStepsLoading: false,
    executionStepsLoadError: '',
    run_id: 'smoke-fileref-run',
    metadata: { run_id: 'smoke-fileref-run' },
    _execState: null,
  };

  return [
    {
      role: 'user',
      id: 'smoke-fileref-user-1',
      seq: 1,
      content: '请展示各类产物的不同展示方式。',
      attachments: [],
      metadata: {},
    },
    assistant,
  ];
}
