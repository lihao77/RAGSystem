/**
 * 前端宿主委托工具：声明本连接可委托执行的工具 + execute 实现。
 *
 * WS 握手期 onopen 发 tools.register（getHostToolDeclarations）；收到 delegate_call(phase=request)
 * 时按 tool 名路由 getHostTool(name).execute，执行完回传 delegate_result(phase=result)。
 *
 * 工具用客户端独有能力（浏览器环境/本地资源），后端无法执行——这正是委托模式的价值。
 */

import { callArtifactMapRuntime } from './artifactMapRuntime.js';

async function runMapTool(method, input, context, successMessage) {
  try {
    const structured = await callArtifactMapRuntime(method, input, context);
    return {
      ok: true,
      observation: `${successMessage}\n${JSON.stringify(structured, null, 2)}`,
      structured,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, observation: message, error: message };
  }
}

const LAYER_ID_SCHEMA = { type: 'string', description: 'map_add_artifact_layer 返回的 layer_id' };
const VECTOR_STYLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: '矢量颜色和专题样式',
  properties: {
    fillColor: { type: 'string' },
    fillOpacity: { type: 'number', minimum: 0, maximum: 1 },
    lineColor: { type: 'string' },
    lineOpacity: { type: 'number', minimum: 0, maximum: 1 },
    lineWidth: { type: 'number', minimum: 0 },
    circleColor: { type: 'string' },
    circleOpacity: { type: 'number', minimum: 0, maximum: 1 },
    circleRadius: { type: 'number', minimum: 1 },
    circleStrokeColor: { type: 'string' },
    circleStrokeWidth: { type: 'number', minimum: 0 },
    thematic: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'method', 'stops'],
      properties: {
        field: { type: 'string' },
        method: { type: 'string', enum: ['categorical', 'step', 'interpolate'] },
        defaultColor: { type: 'string' },
        stops: {
          type: 'array',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['value', 'color'],
            properties: {
              value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              color: { type: 'string' },
              label: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

const HOST_TOOLS = [
  {
    name: 'get_client_env',
    description:
      '获取前端客户端环境信息（时区、语言、浏览器 User-Agent、屏幕分辨率等客户端独有数据）。当需要用户客户端环境上下文（如本地化、展示适配）时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'low',
    async execute() {
      const nav = globalThis.navigator || {};
      const lang = nav.language || 'unknown';
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
      const ua = nav.userAgent || 'unknown';
      const screen = globalThis.screen ? `${globalThis.screen.width}x${globalThis.screen.height}` : 'unknown';
      return {
        ok: true,
        observation: JSON.stringify({ language: lang, timezone: tz, userAgent: ua, screen }, null, 2),
      };
    },
  },
  {
    name: 'map_add_artifact_layer',
    description: '把 Artifact V2 中的空间数据 Asset 加入前端地图工作台。只传 artifact_id；前端按 MIME 和 metadata.spatial 自动识别 GeoJSON、地理配准图片或栅格瓦片。不要生成地图展示配置。',
    inputSchema: {
      type: 'object',
      required: ['artifact_id'],
      additionalProperties: false,
      properties: {
        artifact_id: { type: 'string', description: 'Artifact V2 标识，例如 art_xxx' },
        asset_id: { type: 'string', description: '可选；指定 Manifest 中的 Asset' },
        layer_id: { type: 'string', description: '可选；自定义前端图层标识' },
        title: { type: 'string', description: '可选图层标题' },
        visible: { type: 'boolean', description: '初始是否可见，默认 true' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: '初始透明度，默认 1' },
        fit: { type: 'boolean', description: '添加后是否定位图层，默认 true' },
        style: VECTOR_STYLE_SCHEMA,
      },
    },
    riskLevel: 'medium',
    cancellable: true,
    execute(input, context) {
      return runMapTool('addArtifactLayer', input, context, 'Artifact 图层已加入地图');
    },
  },
  {
    name: 'map_set_layer_style',
    description: '设置 GeoJSON 图层的颜色、透明度或专题分类样式。专题样式支持 categorical、step 和 interpolate。',
    inputSchema: {
      type: 'object',
      required: ['layer_id', 'style'],
      additionalProperties: false,
      properties: { layer_id: LAYER_ID_SCHEMA, style: VECTOR_STYLE_SCHEMA },
    },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('setLayerStyle', input, context, '图层专题样式已更新');
    },
  },
  {
    name: 'map_remove_layer',
    description: '从地图工作台移除一个图层。',
    inputSchema: { type: 'object', required: ['layer_id'], additionalProperties: false, properties: { layer_id: LAYER_ID_SCHEMA } },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('removeLayer', input, context, '地图图层已移除');
    },
  },
  {
    name: 'map_list_layers',
    description: '列出地图工作台当前图层、顺序、显隐和透明度。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'low',
    execute(input, context) {
      return runMapTool('listLayers', input, context, '当前地图图层');
    },
  },
  {
    name: 'map_set_layer_visibility',
    description: '设置地图图层显示或隐藏。',
    inputSchema: {
      type: 'object', required: ['layer_id', 'visible'], additionalProperties: false,
      properties: { layer_id: LAYER_ID_SCHEMA, visible: { type: 'boolean' } },
    },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('setLayerVisibility', input, context, '图层显隐已更新');
    },
  },
  {
    name: 'map_set_layer_opacity',
    description: '设置地图图层透明度。',
    inputSchema: {
      type: 'object', required: ['layer_id', 'opacity'], additionalProperties: false,
      properties: { layer_id: LAYER_ID_SCHEMA, opacity: { type: 'number', minimum: 0, maximum: 1 } },
    },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('setLayerOpacity', input, context, '图层透明度已更新');
    },
  },
  {
    name: 'map_reorder_layer',
    description: '调整地图图层顺序；索引 0 为最底层。',
    inputSchema: {
      type: 'object', required: ['layer_id', 'to_index'], additionalProperties: false,
      properties: { layer_id: LAYER_ID_SCHEMA, to_index: { type: 'integer', minimum: 0 } },
    },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('reorderLayer', input, context, '图层顺序已更新');
    },
  },
  {
    name: 'map_fit_layer',
    description: '打开地图工作台并缩放定位到指定图层。',
    inputSchema: { type: 'object', required: ['layer_id'], additionalProperties: false, properties: { layer_id: LAYER_ID_SCHEMA } },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('fitLayer', input, context, '地图已定位到图层');
    },
  },
  {
    name: 'map_clear_layers',
    description: '清除地图工作台中的全部业务图层。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('clearLayers', input, context, '地图图层已清空');
    },
  },
  {
    name: 'map_get_viewport',
    description: '获取地图当前中心点、缩放级别和可见范围。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    riskLevel: 'low',
    execute(input, context) {
      return runMapTool('getViewport', input, context, '当前地图视口');
    },
  },
  {
    name: 'map_set_viewport',
    description: '设置地图中心、缩放、方位角或俯仰角。一次调用内只提交需要改变的字段。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        center: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: '[longitude, latitude]' },
        zoom: { type: 'number', minimum: 0, maximum: 24 },
        bearing: { type: 'number' },
        pitch: { type: 'number', minimum: 0, maximum: 85 },
        duration: { type: 'number', minimum: 0 },
      },
    },
    riskLevel: 'medium',
    execute(input, context) {
      return runMapTool('setViewport', input, context, '地图视口已更新');
    },
  },
];

const toolMap = new Map(HOST_TOOLS.map((tool) => [tool.name, tool]));

/** wire 声明（tools.register 用，不含 execute 函数——函数不可序列化）。 */
export function getHostToolDeclarations() {
  return HOST_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    ...(tool.riskLevel ? { risk_level: tool.riskLevel } : {}),
    ...(tool.cancellable ? { cancellable: true } : {}),
  }));
}

export function getHostTool(name) {
  return toolMap.get(name) || null;
}
