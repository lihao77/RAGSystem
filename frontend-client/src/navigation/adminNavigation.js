import {
  Activity,
  Book,
  BrainCircuit,
  Database,
  Landmark,
  Layers,
  LayoutGrid,
  Plug,
  Radio,
  Settings,
  SquarePlus,
  UserRound,
  Users,
  Workflow,
} from 'lucide-vue-next';

export const IconAdminCenter = LayoutGrid;

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
    icon: Landmark,
  },
  {
    key: 'platform-users', mainView: 'platform-users', path: '/platform/users', label: '用户治理',
    title: '平台用户治理', description: '跨租户禁用用户，并授予或撤销平台管理员。', group: 'platform', requiresPlatformAdmin: true,
    icon: UserRound,
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
    icon: Users,
  },
  {
    key: 'widget-credentials', mainView: 'widget-credentials', path: '/widget-credentials', label: 'Widget 凭证',
    title: 'Widget 凭证控制台', description: '管理 publishable key、secret、来源白名单与审计记录。', group: 'infrastructure',
    capability: 'widget',
    requireTenantRole: 'owner',
    icon: SquarePlus,
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
    icon: Radio,
  },
  {
    key: 'agent-studio',
    mainView: 'agent-studio',
    path: '/agent-studio',
    label: 'Agent 编排',
    title: 'Team 与 Agent 编排',
    description: '在一个工作台内管理 Team、编排 Agent，并维护模型、工具、技能与委派。',
    group: 'agent-runtime',
    requireTenantRole: 'admin',
    icon: Workflow,
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
    icon: Plug,
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
    icon: Database,
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
    icon: Book,
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
    icon: Activity,
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
    icon: Layers,
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
    icon: Settings,
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
