import { h } from 'vue';

const createAdminIcon = (children) => ({
  render() {
    return h(
      'svg',
      {
        xmlns: 'http://www.w3.org/2000/svg',
        width: '22',
        height: '22',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
      children.map(({ tag, attrs }) => h(tag, attrs))
    );
  },
});

export const IconAdminCenter = createAdminIcon([
  { tag: 'rect', attrs: { x: '3', y: '3', width: '7', height: '7', rx: '1.5' } },
  { tag: 'rect', attrs: { x: '14', y: '3', width: '7', height: '7', rx: '1.5' } },
  { tag: 'rect', attrs: { x: '3', y: '14', width: '7', height: '7', rx: '1.5' } },
  { tag: 'rect', attrs: { x: '14', y: '14', width: '7', height: '7', rx: '1.5' } },
]);

export const adminNavGroups = [
  {
    key: 'agent-runtime',
    label: 'Agent 运行',
    description: '配置 Agent、Team 与运行入口。',
  },
  {
    key: 'infrastructure',
    label: '基础设施',
    description: '管理模型、工具、知识与系统能力。',
  },
  {
    key: 'operations',
    label: '运行与诊断',
    description: '查看状态、守护任务与系统配置。',
  },
];

export const managementNavItems = [
  {
    key: 'model-providers',
    mainView: 'model-providers',
    path: '/model-providers',
    label: '模型管理',
    title: '模型 Provider 管理',
    description: '配置 Provider 实例、模型映射、默认参数，并测试连通性。',
    group: 'infrastructure',
    icon: createAdminIcon([
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
      { tag: 'path', attrs: { d: 'M19.07 4.93a10 10 0 0 1 0 14.14' } },
      { tag: 'path', attrs: { d: 'M4.93 4.93a10 10 0 0 0 0 14.14' } },
    ]),
  },
  {
    key: 'team-builder',
    mainView: 'team-builder',
    path: '/team-builder',
    label: 'Team 编排',
    title: 'Team 方案编排',
    description: '组合入口 Agent、协作链路和 Team 方案，并切换当前团队。',
    group: 'agent-runtime',
    icon: createAdminIcon([
      { tag: 'rect', attrs: { x: '3', y: '4', width: '7', height: '7', rx: '1' } },
      { tag: 'rect', attrs: { x: '14', y: '4', width: '7', height: '7', rx: '1' } },
      { tag: 'rect', attrs: { x: '14', y: '15', width: '7', height: '7', rx: '1' } },
      { tag: 'path', attrs: { d: 'M10 7h4' } },
      { tag: 'path', attrs: { d: 'M17.5 11v4' } },
    ]),
  },
  {
    key: 'agent-config',
    mainView: 'agent-config',
    path: '/agent-config',
    label: 'Agent 配置',
    title: '智能体配置',
    description: '维护 Agent 角色、工具权限、记忆策略、技能和模型偏好。',
    group: 'agent-runtime',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M12 20h9' } },
      { tag: 'path', attrs: { d: 'M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z' } },
    ]),
  },
  {
    key: 'mcp',
    mainView: 'mcp',
    path: '/mcp',
    label: 'MCP 管理',
    title: 'MCP 服务管理',
    description: '安装、连接、测试 MCP 工具服务，并查看可用工具。',
    group: 'infrastructure',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M12 22v-5' } },
      { tag: 'rect', attrs: { x: '6', y: '9', width: '12', height: '6', rx: '2' } },
      { tag: 'path', attrs: { d: 'M10 9V2' } },
      { tag: 'path', attrs: { d: 'M14 9V2' } },
    ]),
  },
  {
    key: 'vector-library',
    mainView: 'vector-library',
    path: '/vector-library',
    label: '知识库',
    title: '知识库管理',
    description: '管理向量库、文档索引、检索测试和知识注入。',
    group: 'infrastructure',
    icon: createAdminIcon([
      { tag: 'ellipse', attrs: { cx: '12', cy: '5', rx: '9', ry: '3' } },
      { tag: 'path', attrs: { d: 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3' } },
      { tag: 'path', attrs: { d: 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5' } },
    ]),
  },
  {
    key: 'monitor',
    mainView: 'monitor',
    path: '/monitor',
    label: '监控面板',
    title: '智能体性能监控',
    description: '查看 Agent 性能、任务状态、运行指标和诊断数据。',
    group: 'operations',
    icon: createAdminIcon([
      { tag: 'polyline', attrs: { points: '22 12 18 12 15 21 9 3 6 12 2 12' } },
    ]),
  },
  {
    key: 'daemon',
    mainView: 'daemon',
    path: '/daemon',
    label: '守护系统',
    title: '守护 Agent 系统',
    description: '管理常驻守护、消息网关、定时任务和心跳监控。',
    group: 'operations',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M12 2L2 7l10 5 10-5-10-5z' } },
      { tag: 'path', attrs: { d: 'M2 17l10 5 10-5' } },
      { tag: 'path', attrs: { d: 'M2 12l10 5 10-5' } },
    ]),
  },
  {
    key: 'system-config',
    mainView: 'system-config',
    path: '/system-config',
    label: '系统配置',
    title: '系统配置',
    description: '管理全局 LLM、向量存储、反思机制等系统级参数。',
    group: 'operations',
    icon: createAdminIcon([
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
      { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' } },
    ]),
  },
];

export const sidebarAdminNavItem = {
  key: 'admin-center',
  mainView: 'admin',
  section: 'admin',
  path: '/admin',
  label: '管理中心',
  title: '模型、Agent、Team、MCP、知识库、监控与系统配置',
  buttonClass: 'sidebar-btn-secondary',
  icon: IconAdminCenter,
};
