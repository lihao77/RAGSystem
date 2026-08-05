import { h } from 'vue';
import { BrainCircuit } from 'lucide-vue-next';

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
    key: 'platform',
    label: '平台管理',
    description: '跨租户运营、用户治理与平台支持。',
  },
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
    description: '查看状态、机器人与系统配置。',
  },
];

export const managementNavItems = [
  {
    key: 'platform-tenants', mainView: 'platform-tenants', path: '/platform/tenants', label: '租户治理',
    title: '平台租户治理', description: '跨租户查看状态，并暂停或恢复租户。', group: 'platform', requiresPlatformAdmin: true,
    icon: createAdminIcon([{ tag: 'path', attrs: { d: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6' } }]),
  },
  {
    key: 'platform-users', mainView: 'platform-users', path: '/platform/users', label: '用户治理',
    title: '平台用户治理', description: '跨租户禁用用户，并授予或撤销平台管理员。', group: 'platform', requiresPlatformAdmin: true,
    icon: createAdminIcon([{ tag: 'circle', attrs: { cx: '12', cy: '8', r: '4' } }, { tag: 'path', attrs: { d: 'M4 21a8 8 0 0 1 16 0' } }]),
  },
  {
    key: 'members',
    mainView: 'members',
    path: '/members',
    label: '成员管理',
    title: '租户成员管理',
    description: '查看租户成员，并按当前角色邀请、调整角色或移除成员。',
    group: 'infrastructure',
    requireTenantRole: 'admin',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' } },
      { tag: 'circle', attrs: { cx: '9', cy: '7', r: '4' } },
      { tag: 'path', attrs: { d: 'M22 21v-2a4 4 0 0 0-3-3.87' } },
      { tag: 'path', attrs: { d: 'M16 3.13a4 4 0 0 1 0 7.75' } },
    ]),
  },
  {
    key: 'widget-credentials', mainView: 'widget-credentials', path: '/widget-credentials', label: 'Widget 凭证',
    title: 'Widget 凭证控制台', description: '管理 publishable key、secret、来源白名单与审计记录。', group: 'infrastructure',
    capability: 'widget',
    requireTenantRole: 'owner',
    icon: createAdminIcon([{ tag: 'rect', attrs: { x: '3', y: '5', width: '18', height: '14', rx: '2' } }, { tag: 'path', attrs: { d: 'M8 12h8M12 8v8' } }]),
  },
  {
    key: 'model-providers',
    mainView: 'model-providers',
    path: '/model-providers',
    label: '模型管理',
    title: '模型 Provider 管理',
    description: '配置 Provider 实例、模型映射、默认参数，并测试连通性。',
    group: 'infrastructure',
    requireTenantRole: 'admin',
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
    requireTenantRole: 'admin',
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
    requireTenantRole: 'admin',
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
    requireTenantRole: 'admin',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M12 22v-5' } },
      { tag: 'rect', attrs: { x: '6', y: '9', width: '12', height: '6', rx: '2' } },
      { tag: 'path', attrs: { d: 'M10 9V2' } },
      { tag: 'path', attrs: { d: 'M14 9V2' } },
    ]),
  },
  {
    key: 'knowledge-base',
    mainView: 'knowledge-base',
    path: '/knowledge-base',
    label: '知识库',
    title: '知识库管理',
    description: '管理知识库、文档索引、检索测试和知识注入。',
    group: 'infrastructure',
    requireTenantRole: 'admin',
    icon: createAdminIcon([
      { tag: 'ellipse', attrs: { cx: '12', cy: '5', rx: '9', ry: '3' } },
      { tag: 'path', attrs: { d: 'M21 12c0 1.66-4 3-9 3s-9-1.34-9-3' } },
      { tag: 'path', attrs: { d: 'M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5' } },
    ]),
  },
  {
    key: 'skill-library',
    mainView: 'skill-library',
    path: '/skill-library',
    label: 'Skill 库',
    title: 'Skill 库管理',
    description: '管理领域技能：查看正文与脚本，新建、编辑、上传与删除用户全局 Skill。',
    group: 'infrastructure',
    requireTenantRole: 'admin',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' } },
      { tag: 'path', attrs: { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z' } },
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
    requireTenantRole: 'admin',
    icon: createAdminIcon([
      { tag: 'polyline', attrs: { points: '22 12 18 12 15 21 9 3 6 12 2 12' } },
    ]),
  },
  {
    key: 'bots',
    mainView: 'bots',
    path: '/bots',
    label: '机器人',
    title: '机器人管理',
    description: '管理私有 Bot 身份、飞书连接、会话策略和定时任务。',
    group: 'operations',
    requireTenantRole: 'member',
    icon: createAdminIcon([
      { tag: 'path', attrs: { d: 'M12 2L2 7l10 5 10-5-10-5z' } },
      { tag: 'path', attrs: { d: 'M2 17l10 5 10-5' } },
      { tag: 'path', attrs: { d: 'M2 12l10 5 10-5' } },
    ]),
  },
  {
    key: 'memory',
    mainView: 'memory',
    path: '/memory',
    label: 'Memory',
    title: 'Memory 管理',
    description: '查看个人与共享记忆，处理候选、审核和历史记录。',
    group: 'agent-runtime',
    requireTenantRole: 'member',
    icon: BrainCircuit,
  },
  {
    key: 'system-config',
    mainView: 'system-config',
    path: '/system-config',
    label: '系统配置',
    title: '系统配置',
    description: '管理记忆、工具限制与上下文预算等系统级参数。',
    group: 'operations',
    requireTenantRole: 'owner',
    icon: createAdminIcon([
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
      { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' } },
    ]),
  },
];

const capabilityByNavigationKey = {
  'tenant-switch': 'tenantSwitch',
  billing: 'billing',
  'widget-credentials': 'widget',
};

export function filterManagementNavItems(capabilities = {}, context = {}) {
  return managementNavItems.filter((item) => {
    if (context.isLocal && (item.requiresPlatformAdmin || item.key === 'members')) {
      return false;
    }
    if (item.requiresPlatformAdmin && !context.isPlatformAdmin) {
      return false;
    }
    if (item.requireTenantRole && (typeof context.hasTenantRole !== 'function' || !context.hasTenantRole(item.requireTenantRole))) {
      return false;
    }
    if (item.requiresPasswordAuth && !(context.isAuthenticated && context.authMode === 'password')) {
      return false;
    }
    const capability = item.capability || capabilityByNavigationKey[item.key];
    return !capability || capabilities[capability] !== false;
  });
}

export const sidebarAdminNavItem = {
  key: 'admin-center',
  mainView: 'admin',
  section: 'admin',
  path: '/admin',
  label: '管理中心',
  title: '模型、Agent、Team、MCP、知识库、监控与系统配置',
  requireTenantRole: 'admin',
  buttonClass: 'sidebar-btn-secondary',
  icon: IconAdminCenter,
};

export const sidebarPlatformNavItem = {
  key: 'platform-center',
  mainView: 'platform',
  section: 'platform',
  path: '/platform/tenants',
  label: '平台控制台',
  title: '跨租户治理与平台运营支持',
  buttonClass: 'sidebar-btn-secondary',
  icon: managementNavItems[0].icon,
};
