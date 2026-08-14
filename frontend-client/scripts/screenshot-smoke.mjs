import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const viteBin = resolve(dirname(fileURLToPath(import.meta.resolve('vite'))), '..', '..', 'bin', 'vite.js');
const host = '127.0.0.1';
const outputDir = resolve(rootDir, 'screenshots', 'smoke');
const minScreenshotBytes = 8 * 1024;
const maxHorizontalOverflowPx = 2;

const shots = [
  {
    name: 'start-page-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectText', selector: '.new-chat-start', text: '要不要先休息一下' },
      { type: 'expectText', selector: '.session-setup-panel', text: 'ragsystem' },
      { type: 'expectVisible', selector: '.input-area-wrapper--new-chat' },
    ],
  },
  {
    name: 'start-page-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectText', selector: '.new-chat-start', text: '要不要先休息一下' },
      { type: 'expectText', selector: '.session-setup-panel', text: 'ragsystem' },
      { type: 'expectVisible', selector: '.input-area-wrapper--new-chat' },
    ],
  },
  {
    name: 'start-page-project-switch',
    path: '/?__smoke=empty',
    width: 960,
    height: 760,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectText', selector: '.session-setup-panel', text: 'ragsystem' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectText', selector: '[role="dialog"]', text: 'ZCodeProject' },
      { type: 'expectCentered', selector: '[role="dialog"]' },
      { type: 'click', selector: '.project-list > li:last-child .project-option' },
      { type: 'expectText', selector: '.session-setup-panel', text: 'ZCodeProject' },
    ],
  },
  {
    name: 'start-page-project-dialog-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectText', selector: '[role="dialog"]', text: '选择项目' },
      { type: 'expectCentered', selector: '[role="dialog"]' },
    ],
  },
  {
    name: 'start-page-project-dialog-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectText', selector: '[role="dialog"]', text: '选择项目' },
      { type: 'expectCentered', selector: '[role="dialog"]' },
    ],
  },
  {
    name: 'project-sidebar-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectText', selector: '.sidebar', text: 'ragsystem' },
      { type: 'expectText', selector: '.sidebar', text: 'ZCodeProject' },
      { type: 'expectVisible', selector: '[aria-label="添加本地项目"]' },
    ],
  },
  {
    name: 'project-sidebar-remove-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '[aria-label="管理项目 ragsystem"]' },
      { type: 'click', selector: '[aria-label="管理项目 ragsystem"]' },
      { type: 'expectText', selector: '[role="menu"]', text: '移除项目' },
      { type: 'click', selector: '[role="menuitem"]' },
      { type: 'expectText', selector: '[role="alertdialog"]', text: '确定要移除项目“ragsystem”吗？' },
      { type: 'expectCentered', selector: '[role="alertdialog"]' },
    ],
  },
  {
    name: 'project-sidebar-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'click', selector: '[aria-label="打开菜单"]', waitMs: 300 },
      { type: 'expectText', selector: '.sidebar', text: 'ragsystem' },
      { type: 'expectText', selector: '.sidebar', text: 'ZCodeProject' },
      { type: 'expectVisible', selector: '.sidebar.mobile-open' },
    ],
  },
  {
    name: 'project-sidebar-remove-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'click', selector: '[aria-label="打开菜单"]', waitMs: 300 },
      { type: 'expectVisible', selector: '[aria-label="管理项目 ragsystem"]' },
      { type: 'click', selector: '[aria-label="管理项目 ragsystem"]' },
      { type: 'expectText', selector: '[role="menu"]', text: '移除项目' },
    ],
  },
  {
    name: 'timeline-sidebar-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'click', selector: '[aria-label="打开菜单"]', waitMs: 300 },
      { type: 'click', selector: '[aria-label="时间轴视图"]', waitMs: 300 },
      { type: 'expectText', selector: '.sidebar', text: '智能体系统接入 Host MCP' },
      { type: 'expectText', selector: '.session-list-items', text: 'ragsystem' },
      { type: 'expectVisible', selector: '.sidebar.mobile-open' },
    ],
  },
  {
    name: 'chat-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'expectText', selector: 'body', text: '要不要先休息一下' },
      { type: 'expectVisible', selector: '.new-chat-start h1' },
      { type: 'expectVisible', selector: '.session-setup-panel' },
      { type: 'expectVisible', selector: '[aria-label="更多会话操作"]' },
    ],
  },
  {
    name: 'chat-mobile-session',
    path: '/?__smoke=artifact',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectText', selector: '.conversation-title', text: '生成一张水位趋势图' },
      { type: 'expectVisible', selector: '.composer-run-controls' },
    ],
  },
  {
    name: 'chat-inline-execution-mobile',
    path: '/?__smoke=artifact',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectText', selector: '.message-stream', text: '工具调用' },
      { type: 'click', selector: 'button[title="展开执行步骤"]', waitMs: 300 },
      { type: 'expectText', selector: '.message-stream', text: '读取监测数据并生成趋势图。' },
      { type: 'expectVisible', selector: 'button[title="收起执行步骤"]' },
    ],
  },
  {
    name: 'chat-mobile-runtime-execution',
    path: '/?__smoke=artifact',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '[aria-label="打开运行中心"]' },
      { type: 'click', selector: '[aria-label="打开运行中心"]', waitMs: 400 },
      { type: 'expectText', selector: '.runtime-overview', text: '运行中心' },
      { type: 'expectText', selector: '.runtime-overview', text: 'Goal' },
      { type: 'expectText', selector: '.runtime-overview', text: '后台任务' },
    ],
  },
  {
    name: 'chat-mobile-session-menu',
    path: '/?__smoke=artifact',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectText', selector: '.conversation-title', text: '生成一张水位趋势图' },
      { type: 'click', selector: '[aria-label="更多会话操作"]' },
      { type: 'expectText', selector: '[role="menu"]', text: '文件变更' },
      { type: 'expectText', selector: '[role="menu"]', text: '导出会话' },
    ],
  },
  {
    name: 'desktop-workbench-artifact',
    path: '/?__smoke=artifact',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectText', selector: '.message-stream', text: 'smoke fixture' },
      { type: 'expectText', selector: '.workspace-file-card', text: 'water-level-report.csv' },
      { type: 'expectVisible', selector: '[aria-label="打开运行中心"]' },
      { type: 'click', selector: '[aria-label="打开运行中心"]', waitMs: 300 },
      { type: 'expectText', selector: '.runtime-overview', text: '持续目标与后台任务' },
    ],
  },
  {
    name: 'map-workspace-desktop',
    path: '/?__smoke=artifact',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'mockMapArtifactApi' },
      { type: 'expectText', selector: '.conversation-title', text: '生成一张水位趋势图' },
      { type: 'invokeMapArtifactTool' },
      { type: 'expectText', selector: '.artifact-map-screen', text: '空间数据工作台' },
      { type: 'expectText', selector: '.artifact-map-screen aside', text: '洪水风险专题图' },
      { type: 'expectText', selector: '.artifact-map-screen aside', text: '高风险' },
      { type: 'expectMapCanvas' },
    ],
  },
  {
    name: 'map-workspace-mobile',
    path: '/?__smoke=artifact',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'mockMapArtifactApi' },
      { type: 'expectText', selector: '.conversation-title', text: '生成一张水位趋势图' },
      { type: 'invokeMapArtifactTool' },
      { type: 'expectText', selector: '.artifact-map-screen', text: '空间数据工作台' },
      { type: 'expectText', selector: '.artifact-map-screen aside', text: '洪水风险专题图' },
      { type: 'expectVisible', selector: '.artifact-map-screen aside' },
      { type: 'expectVisible', selector: '.floating-chat-panel.collapsed' },
      { type: 'expectMapCanvas' },
    ],
  },
  {
    name: 'desktop-runtime-background',
    path: '/?__smoke=artifact',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'click', selector: '[aria-label="打开运行中心"]', waitMs: 250 },
      { type: 'expectText', selector: '.runtime-overview', text: '运行中心' },
      { type: 'expectText', selector: '.runtime-overview', text: '后台任务' },
      { type: 'expectTop', selector: '.runtime-overview-header', maxTop: 120 },
    ],
  },
  {
    name: 'file-changes-desktop',
    path: '/?__smoke=artifact',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'click', selector: '[aria-label="更多会话操作"]' },
      { type: 'expectText', selector: '[role="menu"]', text: '文件变更' },
      { type: 'click', selector: '[role="menuitem"]', waitMs: 500 },
      { type: 'expectVisible', selector: '.file-changes-sheet' },
      { type: 'expectText', selector: '.file-changes-sheet', text: 'WaterLevelChart.vue' },
    ],
  },
  {
    name: 'chat-artifact-narrow',
    path: '/?__smoke=artifact',
    width: 1280,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectText', selector: '.message-stream', text: 'smoke fixture' },
      { type: 'expectVisible', selector: '[aria-label="打开运行中心"]' },
    ],
  },
  {
    name: 'chat-pending-image-recognizing-desktop',
    path: '/?__smoke=pending-image',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectVisible', selector: '.pending-image-message--recognizing' },
      { type: 'expectText', selector: '.pending-image-status', text: '正在识别图片…（已完成 1/2）' },
      { type: 'expectVisible', selector: '.pending-image-thumb-badge--ok' },
      { type: 'expectVisible', selector: '.pending-image-thumb-overlay' },
    ],
  },
  {
    name: 'chat-pending-image-done-desktop',
    path: '/?__smoke=pending-image&__phase=done',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectVisible', selector: '.pending-image-message--done' },
      { type: 'expectText', selector: '.pending-image-status', text: '识别完成' },
    ],
  },
  {
    name: 'chat-pending-image-sending-mobile',
    path: '/?__smoke=pending-image&__phase=sending',
    width: 390,
    height: 844,
    actions: [
      { type: 'expectVisible', selector: '.pending-image-message--sending' },
      { type: 'expectText', selector: '.pending-image-status', text: '正在发送…' },
    ],
  },
  {
    name: 'chat-pending-image-newchat-desktop',
    path: '/?__smoke=pending-image-newchat',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.pending-image-message--recognizing' },
      { type: 'expectText', selector: '.pending-image-status', text: '正在识别图片…（已完成 1/2）' },
      // 幽灵气泡激活即视为对话开始：composer 沉底（has-messages 相位），不停留居中启动态
      { type: 'expectVisible', selector: '.chat-main.has-messages .pending-image-message' },
    ],
  },
  { name: 'admin-mobile', path: '/admin', width: 390, height: 844 },
  { name: 'admin-desktop', path: '/admin', width: 1440, height: 900 },
  {
    name: 'desktop-agent-config',
    path: '/agent-config',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectText', selector: 'body', text: 'Agent 配置' },
      { type: 'expectText', selector: '.config-form', text: '基础信息' },
    ],
  },
  { name: 'agent-config-narrow', path: '/agent-config', width: 768, height: 900 },
  {
    name: 'desktop-team-builder',
    path: '/team-builder',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectText', selector: 'body', text: 'Team 编排' },
      { type: 'expectText', selector: 'body', text: '创建新方案' },
    ],
  },
  { name: 'team-builder-mobile', path: '/team-builder', width: 390, height: 844 },
  {
    name: 'desktop-knowledge-base',
    path: '/knowledge-base',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectText', selector: 'body', text: '知识库管理' },
      { type: 'expectText', selector: 'body', text: '文件与索引' },
    ],
  },
  {
    name: 'knowledge-base-search-desktop',
    path: '/knowledge-base',
    width: 1440,
    height: 900,
    actions: [
      { type: 'click', selector: '.kb-manager-page nav button:nth-child(4)', waitMs: 500 },
      { type: 'expectText', selector: 'body', text: '检索工作台' },
      { type: 'expectVisible', selector: 'input[aria-label="搜索查询"]' },
    ],
  },
  { name: 'model-providers-narrow', path: '/model-providers', width: 768, height: 900 },
  {
    name: 'model-providers-test-menu',
    path: '/model-providers',
    width: 1440,
    height: 900,
    actions: [
      { type: 'click', selector: '.provider-row:nth-child(3) .provider-row-actions button:first-child' },
      { type: 'expectText', selector: '[role="menu"]', text: '选择真实调用任务' },
      { type: 'expectText', selector: '[role="menu"]', text: 'Chat' },
      { type: 'expectText', selector: '[role="menu"]', text: 'Embedding' },
      { type: 'expectVisible', selector: '[role="menu"]' },
    ],
  },
  {
    name: 'model-providers-create-dialog',
    path: '/model-providers',
    width: 1440,
    height: 900,
    actions: [
      { type: 'click', selector: '[aria-label="添加 Provider"]' },
      { type: 'expectText', selector: '[role="dialog"]', text: '基础配置' },
      { type: 'expectText', selector: '[role="dialog"]', text: '模型映射' },
      { type: 'expectVisible', selector: '[role="dialog"] .provider-dialog-submit' },
    ],
  },
  {
    name: 'model-providers-edit-dialog-bottom',
    path: '/model-providers',
    width: 1440,
    height: 900,
    actions: [
      { type: 'click', selector: '.provider-row .provider-row-actions button:nth-child(2)' },
      { type: 'expectText', selector: '[role="dialog"]', text: '编辑 Provider' },
      { type: 'scrollToBottom', selector: '[role="dialog"]' },
      { type: 'expectVisible', selector: '[role="dialog"] .model-map-editor' },
      { type: 'expectVisible', selector: '[role="dialog"] .provider-dialog-submit' },
    ],
  },
  {
    name: 'model-providers-delete-dialog',
    path: '/model-providers',
    width: 1440,
    height: 900,
    actions: [
      { type: 'click', selector: '.provider-row .provider-row-actions button:nth-child(3)', waitMs: 750 },
      { type: 'expectText', selector: '[role="dialog"]', text: '确认删除' },
    ],
  },
  { name: 'knowledge-base-mobile', path: '/knowledge-base', width: 390, height: 844 },
  {
    name: 'knowledge-base-search-mobile',
    path: '/knowledge-base',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.kb-manager-page nav button:nth-child(4)', waitMs: 500 },
      { type: 'expectText', selector: 'body', text: '检索工作台' },
      { type: 'expectVisible', selector: 'input[aria-label="搜索查询"]' },
    ],
  },
  {
    name: 'knowledge-base-search-results-desktop',
    path: '/knowledge-base',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockKnowledgeSearchApi' },
      { type: 'click', selector: '.kb-manager-page nav button:nth-child(4)', waitMs: 500 },
      { type: 'click', selector: '[role="switch"]' },
      { type: 'setValue', selector: 'input[aria-label="搜索查询"]', value: '如何配置 RAG 检索？' },
      { type: 'click', selector: 'input[aria-label="搜索查询"] + button', waitMs: 500 },
      { type: 'expectText', selector: 'body', text: '检索结果' },
      { type: 'expectText', selector: 'body', text: 'handbook.md' },
      { type: 'scrollToBottom', selector: '.page-content-scroll' },
      { type: 'expectVisible', selector: '[data-result-id="kb-smoke-1"]' },
    ],
  },
  {
    name: 'knowledge-base-search-results-mobile',
    path: '/knowledge-base',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockKnowledgeSearchApi' },
      { type: 'click', selector: '.kb-manager-page nav button:nth-child(4)', waitMs: 500 },
      { type: 'click', selector: '[role="switch"]' },
      { type: 'setValue', selector: 'input[aria-label="搜索查询"]', value: '如何配置 RAG 检索？' },
      { type: 'click', selector: 'input[aria-label="搜索查询"] + button', waitMs: 500 },
      { type: 'expectText', selector: 'body', text: '检索结果' },
      { type: 'scrollToBottom', selector: '.page-content-scroll' },
      { type: 'expectVisible', selector: '[data-result-id="kb-smoke-1"]' },
    ],
  },
  {
    name: 'knowledge-base-reranker-dialog',
    path: '/knowledge-base',
    width: 1440,
    height: 900,
    actions: [
      { type: 'click', selector: '.kb-manager-page nav button:nth-child(3)', waitMs: 500 },
      { type: 'click', selector: '.toolbar-primary-action' },
      { type: 'expectText', selector: '[role="dialog"]', text: 'Rerank Provider' },
      { type: 'expectText', selector: '[role="dialog"]', text: '始终跟随 Provider 当前配置' },
    ],
  },
  {
    name: 'knowledge-base-reranker-dialog-mobile',
    path: '/knowledge-base',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.kb-manager-page nav button:nth-child(3)', waitMs: 500 },
      { type: 'click', selector: '.toolbar-primary-action' },
      { type: 'expectText', selector: '[role="dialog"]', text: 'Rerank Provider' },
      { type: 'expectVisible', selector: '[role="dialog"]' },
    ],
  },
  {
    name: 'desktop-mcp-manager',
    path: '/mcp',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectText', selector: 'body', text: 'MCP 服务管理' },
      { type: 'expectText', selector: 'body', text: '已安装服务' },
    ],
  },
  { name: 'mcp-narrow', path: '/mcp', width: 768, height: 900 },
  { name: 'monitor-narrow', path: '/monitor', width: 768, height: 900 },
  {
    name: 'desktop-daemon',
    path: '/daemon',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectText', selector: 'body', text: '守护 Agent' },
      { type: 'expectText', selector: 'body', text: '基础配置' },
    ],
  },
  { name: 'daemon-narrow', path: '/daemon', width: 768, height: 900 },
  { name: 'system-config-mobile', path: '/system-config', width: 390, height: 844 },
  {
    name: 'agent-config-mobile-menu',
    path: '/agent-config',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '保存配置' },
    ],
  },
  {
    name: 'agent-config-mobile-bottom',
    path: '/agent-config',
    width: 390,
    height: 844,
    actions: [
      { type: 'scrollToBottom', selector: '.page-content-scroll' },
      { type: 'expectText', selector: '.config-form', text: '委派' },
      { type: 'expectVisible', selector: '#section-delegation' },
    ],
  },
  {
    name: 'daemon-mobile-menu',
    path: '/daemon',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '刷新' },
    ],
  },
  {
    name: 'system-config-mobile-menu',
    path: '/system-config',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '保存配置' },
    ],
  },
  {
    name: 'model-providers-mobile-menu',
    path: '/model-providers',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '添加 Provider' },
    ],
  },
  {
    name: 'model-providers-mobile-dialog',
    path: '/model-providers',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'click', selector: '.page-mobile-menu__list .pl-menu-item:first-child' },
      { type: 'expectText', selector: '[role="dialog"]', text: '基础配置' },
      { type: 'expectVisible', selector: '[role="dialog"] .provider-dialog-submit' },
    ],
  },
  {
    name: 'knowledge-base-mobile-menu',
    path: '/knowledge-base',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '全局刷新' },
    ],
  },
  {
    name: 'mcp-mobile-menu',
    path: '/mcp',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '刷新' },
    ],
  },
  {
    name: 'monitor-mobile-menu',
    path: '/monitor',
    width: 390,
    height: 844,
    actions: [
      { type: 'click', selector: '.page-mobile-nav__more' },
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '重置指标' },
    ],
  },
];

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();

  return new Promise((resolveReady, reject) => {
    const tick = () => {
      const req = get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolveReady();
          return;
        }
        retry();
      });

      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 250);
    };

    tick();
  });
}

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolveJson, reject) => {
    const req = get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${url} returned ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolveJson(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForDevtools(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  const listUrl = `http://${host}:${port}/json/list`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await getJson(listUrl, 1000);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await wait(200);
  }

  throw new Error(`Timed out waiting for Chrome DevTools on port ${port}`);
}

function startDevServer(port) {
  const child = spawn(
    process.execPath,
    [viteBin, '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  child.stdout.resume();
  child.stderr.pipe(process.stderr);

  return child;
}

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

function stopDevServer(child) {
  stopProcessTree(child);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.ws = new WebSocket(webSocketUrl);
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
      this.ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.method) {
          this.eventHandlers.get(message.method)?.(message.params || {});
          return;
        }
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          return;
        }
        pending.resolve(message.result);
      });
    });
  }

  on(method, handler) {
    this.eventHandlers.set(method, handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(payload);
    });
  }

  close() {
    this.ws.close();
  }
}

async function setupShotMocks(client, shot) {
  const mockArtifactApi = (shot.actions || []).some(action => action.type === 'mockArtifactApi');
  const mockMapArtifactApi = (shot.actions || []).some(action => action.type === 'mockMapArtifactApi');
  const mockKnowledgeSearchApi = (shot.actions || []).some(action => action.type === 'mockKnowledgeSearchApi');
  const mockSessionSidebarApi = (shot.actions || []).some(action => action.type === 'mockSessionSidebarApi');
  if (!mockArtifactApi && !mockMapArtifactApi && !mockKnowledgeSearchApi && !mockSessionSidebarApi) return;

  await client.send('Fetch.enable', {
    patterns: [
      ...(mockArtifactApi ? [
        {
          urlPattern: '*://*/api/artifacts/art_smoke_chart*',
          requestStage: 'Request',
        },
        {
          urlPattern: '*://*/api/agent/sessions/smoke-artifact-session/file-changes*',
          requestStage: 'Request',
        },
        {
          urlPattern: '*://*/api/agent/sessions/smoke-artifact-session/goals/current*',
          requestStage: 'Request',
        },
        {
          urlPattern: '*://*/api/agent/sessions/smoke-artifact-session/background-tasks*',
          requestStage: 'Request',
        },
        {
          urlPattern: '*://*/api/agent/sessions/smoke-artifact-session/workspace-files/content*',
          requestStage: 'Request',
        },
      ] : []),
      ...(mockMapArtifactApi ? [{
        urlPattern: '*://*/api/artifacts/art_smoke_map*',
        requestStage: 'Request',
      }] : []),
      ...(mockKnowledgeSearchApi ? [{
        urlPattern: '*://*/api/knowledge-bases/search*',
        requestStage: 'Request',
      }] : []),
      ...(mockSessionSidebarApi ? [
        {
          urlPattern: '*://*/api/agent/workspaces*',
          requestStage: 'Request',
        },
        {
          urlPattern: '*://*/api/agent/sessions*',
          requestStage: 'Request',
        },
      ] : []),
    ],
  });

  client.on('Fetch.requestPaused', async (event) => {
    if (mockSessionSidebarApi) {
      const requestUrl = new URL(event.request.url);
      const workspaceRagsystem = {
        workspace_id: 'ws-ragsystem',
        display_name: 'ragsystem',
        root_path: 'D:/python/ragsystem',
      };
      const workspaceZcode = {
        workspace_id: 'ws-zcode',
        display_name: 'ZCodeProject',
        root_path: 'D:/projects/ZCodeProject',
      };
      let responseData = null;
      if (requestUrl.pathname === '/api/agent/workspaces') {
        responseData = {
          items: [
            { ...workspaceRagsystem, session_count: 3 },
            { ...workspaceZcode, session_count: 0 },
          ],
        };
      } else if (requestUrl.pathname === '/api/agent/sessions/facets') {
        responseData = {
          type_counts: { direct: 3, bot: 0, widget: 0 },
          origins: [],
          workspaces: [
            { ...workspaceRagsystem, count: 3 },
            { ...workspaceZcode, count: 0 },
          ],
        };
      } else if (requestUrl.pathname === '/api/agent/sessions') {
        const origin = { type: 'direct', id: null, display_name: '直接对话', channel: 'web' };
        responseData = {
          items: [
            {
              session_id: 'session-host-mcp',
              title: '智能体系统接入 Host MCP',
              first_message: '智能体系统接入 Host MCP',
              last_message: '',
              activity_at: '2026-08-06T10:00:00.000Z',
              unread_count: 0,
              origin,
              workspace: workspaceRagsystem,
            },
            {
              session_id: 'session-glm',
              title: 'agent-llm 智谱 GLM4-7B',
              first_message: 'agent-llm 智谱 GLM4-7B',
              last_message: '',
              activity_at: '2026-08-05T10:00:00.000Z',
              unread_count: 0,
              origin,
              workspace: workspaceRagsystem,
            },
            {
              session_id: 'session-permissions',
              title: 'frontend-client 控制台权限',
              first_message: 'frontend-client 控制台权限',
              last_message: '',
              activity_at: '2026-08-04T10:00:00.000Z',
              unread_count: 0,
              origin,
              workspace: workspaceRagsystem,
            },
          ],
          next_cursor: null,
        };
      }

      if (responseData) {
        const body = JSON.stringify({ success: true, message: 'ok', data: responseData });
        await client.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json; charset=utf-8' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: Buffer.from(body, 'utf8').toString('base64'),
        });
        return;
      }
    }

    if (event.request?.url?.includes('/api/artifacts/art_smoke_map/assets/geojson/content')) {
      const body = JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: '西部片区', risk: 'low' },
            geometry: { type: 'Polygon', coordinates: [[[107.6, 22.4], [108.2, 22.4], [108.2, 23.3], [107.6, 23.3], [107.6, 22.4]]] },
          },
          {
            type: 'Feature',
            properties: { name: '中心片区', risk: 'medium' },
            geometry: { type: 'Polygon', coordinates: [[[108.2, 22.4], [108.7, 22.4], [108.7, 23.3], [108.2, 23.3], [108.2, 22.4]]] },
          },
          {
            type: 'Feature',
            properties: { name: '东部片区', risk: 'high' },
            geometry: { type: 'Polygon', coordinates: [[[108.7, 22.4], [109.1, 22.4], [109.1, 23.3], [108.7, 23.3], [108.7, 22.4]]] },
          },
        ],
      });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/geo+json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (event.request?.url?.endsWith('/api/artifacts/art_smoke_map')) {
      const body = JSON.stringify({
        schema_version: 2,
        artifact_id: 'art_smoke_map',
        revision: 1,
        session_id: 'smoke-artifact-session',
        kind: 'geospatial.vector',
        subtype: 'flood-risk',
        title: '洪水风险专题图',
        status: 'ready',
        assets: [{
          asset_id: 'geojson',
          role: 'data',
          filename: 'flood-risk.geojson',
          media_type: 'application/geo+json',
          size: 1024,
          sha256: 'smoke',
        }],
        presentations: [],
        metadata: { spatial: { crs: 'EPSG:4326', bounds: [107.5, 22.3, 109.2, 23.5] } },
        provenance: {},
        relations: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (event.request?.url?.includes('/api/knowledge-bases/search')) {
      const body = JSON.stringify({
        success: true,
        data: {
          results: [
            {
              id: 'kb-smoke-1',
              doc_id: 'doc-handbook',
              document_id: 'doc-handbook',
              collection: 'documents',
              text: '先配置 Embedding Provider，再为集合建立索引。检索阶段可选择向量或混合模式，并在召回后启用 Rerank。',
              content: '先配置 Embedding Provider，再为集合建立索引。检索阶段可选择向量或混合模式，并在召回后启用 Rerank。',
              metadata: {
                source_file: 'handbook.md',
                heading_path: '知识库 / 检索配置',
                chunk_index: 1,
                chunk_total: 8,
              },
              score: 0.94,
              similarity: 0.82,
              keyword_score: 0.88,
              vector_score: 0.82,
              hybrid_score: 0.9919,
              final_score: 0.94,
              score_type: 'rerank',
              final_rank: 1,
              vector_rank: 2,
              keyword_rank: 1,
              hybrid_rank: 1,
              rerank_score: 0.94,
              rerank_rank: 1,
              retrieval_sources: ['vector', 'keyword'],
            },
          ],
          count: 1,
          collection_name: null,
          collection_scope: 'all',
          query: '如何配置 RAG 检索？',
          search_mode: 'hybrid',
          rerank_requested: true,
          rerank: true,
          rerank_mode: 'model',
          rerank_error: null,
          diagnostics: {
            candidate_count: 20,
            vector_candidate_count: 20,
            keyword_candidate_count: 14,
            fused_candidate_count: 24,
            filters_applied: [],
            fusion: { method: 'rrf', rrf_k: 60 },
            vectorizer: {
              vectorizer_key: 'openai_embedding',
              provider_key: 'openrouter_openrouter',
              model_name: 'text-embedding-3-small',
              model_id: 1,
            },
            reranker: {
              reranker_key: 'provider_rerank',
              provider_key: 'rerank-provider',
              model_name: 'bge-reranker-v2-m3',
              mode: 'model',
            },
            timings_ms: { embedding: 18.4, retrieval: 7.2, vector_retrieval: 6.8, keyword_retrieval: 4.1, scoring: 0.8, rerank: 31.5, total: 58.3 },
          },
        },
      });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (event.request?.url?.includes('/api/agent/sessions/smoke-artifact-session/goals/current')) {
      const body = JSON.stringify({
        goal: {
          id: 'goal-smoke',
          objective: '完成水位趋势分析并交付图表',
          status: 'active',
          continuation_count: 1,
          steps: [
            { id: 'collect', title: '读取监测数据', status: 'completed' },
            { id: 'deliver', title: '生成并核对图表', status: 'in_progress' },
          ],
        },
      });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (event.request?.url?.includes('/api/agent/sessions/smoke-artifact-session/background-tasks')) {
      const body = JSON.stringify({
        tasks: [{
          task_id: 'task-smoke-export',
          description: '导出水位趋势图',
          kind: 'artifact_export',
          status: 'running',
          run_id: 'smoke-run',
          cancel_available: true,
          started_at: 1,
        }],
      });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (event.request?.url?.includes('/api/agent/sessions/smoke-artifact-session/workspace-files/content')) {
      const body = 'time,level\n08:00,10.8\n10:00,11.4\n12:00,12.0\n';
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/csv' },
          { name: 'Content-Length', value: String(Buffer.byteLength(body)) },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (event.request?.url?.includes('/api/agent/sessions/smoke-artifact-session/file-changes')) {
      const body = JSON.stringify({
        success: true,
        files: [
          {
            path: 'src/components/WaterLevelChart.vue',
            action: 'created',
            diff: [
              { type: 'added', oldLine: null, newLine: 1, content: '<template>' },
              { type: 'added', oldLine: null, newLine: 2, content: '  <ChartRenderer :config="config" />' },
            ],
          },
          {
            path: 'src/views/DashboardView.vue',
            action: 'modified',
            diff: [
              { type: 'context', oldLine: 18, newLine: 18, content: '<main>' },
              { type: 'added', oldLine: null, newLine: 19, content: '  <WaterLevelChart />' },
            ],
          },
        ],
      });
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(body, 'utf8').toString('base64'),
      });
      return;
    }

    if (!event.request?.url?.includes('/api/artifacts/art_smoke_chart')) {
      await client.send('Fetch.continueRequest', { requestId: event.requestId });
      return;
    }

    const body = JSON.stringify({
      schema_version: 2,
      artifact_id: 'art_smoke_chart',
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
        title: { text: 'Smoke 水位趋势', left: 'center' },
        tooltip: { trigger: 'axis' },
        legend: { top: 28, data: ['水位', '警戒线'] },
        grid: { left: 48, right: 24, top: 72, bottom: 48 },
        xAxis: { type: 'category', boundaryGap: false, data: ['08:00', '10:00', '12:00', '14:00', '16:00'] },
        yAxis: { type: 'value', name: 'm', min: 10 },
        dataZoom: [
          { type: 'inside', start: 0, end: 100 },
          { type: 'slider', height: 18, bottom: 14 },
        ],
        series: [
          { name: '水位', type: 'line', smooth: true, symbolSize: 8, data: [10.8, 11.4, 12.3, 12.9, 12.1] },
          { name: '警戒线', type: 'line', symbol: 'none', lineStyle: { type: 'dashed' }, data: [12, 12, 12, 12, 12] },
        ],
        },
      }],
      metadata: {},
      provenance: {},
      relations: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });

    await client.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(body, 'utf8').toString('base64'),
    });
  });
}

async function waitForReady(client, timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await client.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (result.result?.value === 'complete') {
      await wait(750);
      return;
    }
    await wait(200);
  }

  throw new Error('Timed out waiting for document.readyState=complete');
}

async function waitForRouteTransition(client, timeoutMs = 5000) {
  const startedAt = Date.now();
  const transitionSelector = [
    '.slide-forward-enter-active',
    '.slide-forward-leave-active',
    '.slide-backward-enter-active',
    '.slide-backward-leave-active',
  ].join(',');

  while (Date.now() - startedAt < timeoutMs) {
    const active = await evaluate(client, `document.querySelector(${jsString(transitionSelector)}) !== null`);
    if (!active) {
      await wait(100);
      return;
    }
    await wait(100);
  }

  throw new Error('Timed out waiting for route transition to settle');
}

async function measureLayout(client) {
  const expression = `(() => {
    const doc = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const documentScrollWidth = Math.max(
      doc.scrollWidth,
      body ? body.scrollWidth : 0,
      doc.getBoundingClientRect().width,
      body ? body.getBoundingClientRect().width : 0
    );
    const horizontalOverflow = Math.max(0, Math.ceil(documentScrollWidth - viewportWidth));
    const visibleElements = Array.from(document.querySelectorAll('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const overRight = Math.ceil(rect.right - viewportWidth);
        const overLeft = Math.ceil(-rect.left);
        if (overRight <= 2 && overLeft <= 2) return null;
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.className || '').slice(0, 120),
          text: String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          overLeft,
          overRight
        };
      })
      .filter(Boolean)
      .slice(0, 5);
    return {
      viewportWidth,
      viewportHeight,
      documentScrollWidth: Math.ceil(documentScrollWidth),
      horizontalOverflow,
      visibleElements
    };
  })()`;

  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });

  return result.result.value;
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return result.result?.value;
}

async function waitForEvaluation(client, expression, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, expression)) return true;
    await wait(100);
  }
  return false;
}

function jsString(value) {
  return JSON.stringify(String(value));
}

async function runShotActions(client, shot) {
  for (const action of shot.actions || []) {
    if (action.type === 'mockArtifactApi' || action.type === 'mockMapArtifactApi' || action.type === 'mockKnowledgeSearchApi' || action.type === 'mockSessionSidebarApi') {
      continue;
    }

    if (action.type === 'invokeMapArtifactTool') {
      const result = await evaluate(client, `(async () => {
        const { getHostTool } = await import('/src/utils/hostTools.js');
        return getHostTool('map_add_artifact_layer').execute({
          artifact_id: 'art_smoke_map',
          title: '洪水风险专题图',
          style: {
            fillOpacity: 0.72,
            lineColor: '#202124',
            lineWidth: 1.5,
            thematic: {
              field: 'risk',
              method: 'categorical',
              defaultColor: '#a1a1aa',
              stops: [
                { value: 'low', color: '#2f855a', label: '低风险' },
                { value: 'medium', color: '#eab308', label: '中风险' },
                { value: 'high', color: '#dc2626', label: '高风险' },
              ],
            },
          },
        }, {});
      })()`);
      if (!result?.ok) {
        throw new Error(`${shot.name} failed to add map Artifact: ${result?.error || result?.observation || 'unknown error'}`);
      }
      await wait(action.waitMs ?? 3000);
      continue;
    }

    if (action.type === 'expectMapCanvas') {
      const rendered = await waitForEvaluation(client, `(() => {
        const section = document.querySelector('.artifact-map-screen section[aria-label="地理空间地图工作台"]');
        const canvas = section?.querySelector('.maplibregl-canvas');
        if (!section || !canvas || document.body?.innerText?.includes('地图加载中')) return false;
        const sectionRect = section.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        return canvasRect.width >= sectionRect.width * 0.95 && canvasRect.height >= sectionRect.height * 0.95;
      })()`, action.timeoutMs ?? 30000);
      if (!rendered) throw new Error(`${shot.name} MapLibre canvas did not fill the map workspace`);
      continue;
    }

    if (action.type === 'setValue') {
      const updated = await evaluate(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        element.value = ${jsString(action.value)};
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!updated) {
        throw new Error(`${shot.name} could not find value selector: ${action.selector}`);
      }
      await wait(action.waitMs ?? 100);
      continue;
    }

    if (action.type === 'click') {
      const clicked = await evaluate(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`);
      if (!clicked) {
        throw new Error(`${shot.name} could not find clickable selector: ${action.selector}`);
      }
      await wait(action.waitMs ?? 250);
      continue;
    }

    if (action.type === 'expectText') {
      const found = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        return !!element && element.textContent.includes(${jsString(action.text)});
      })()`, action.timeoutMs ?? 30000);
      if (!found) {
        const pageState = await evaluate(client, `(() => ({
          href: window.location.href,
          title: document.title,
          bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
          appHtml: String(document.querySelector('#app')?.innerHTML || '').slice(0, 240),
        }))()`);
        throw new Error(
          `${shot.name} did not find text "${action.text}" in ${action.selector}. ` +
          `Page state: ${JSON.stringify(pageState)}`,
        );
      }
      continue;
    }

    if (action.type === 'scrollToBottom') {
      const scrolled = await evaluate(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        element.scrollTop = element.scrollHeight;
        return true;
      })()`);
      if (!scrolled) {
        throw new Error(`${shot.name} could not find scroll selector: ${action.selector}`);
      }
      await wait(action.waitMs ?? 500);
      continue;
    }

    if (action.type === 'expectVisible') {
      const visible = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
      })()`, action.timeoutMs ?? 30000);
      if (!visible) {
        const visibilityState = await evaluate(client, `(() => {
          const element = document.querySelector(${jsString(action.selector)});
          const rect = element?.getBoundingClientRect();
          const wrapper = document.querySelector('.chat-messages-wrapper');
          return {
            href: window.location.href,
            bodyText: String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
            appHtml: String(document.querySelector('#app')?.innerHTML || '').slice(0, 240),
            rect: rect ? { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
            wrapperScrollTop: wrapper?.scrollTop ?? null,
            wrapperScrollHeight: wrapper?.scrollHeight ?? null,
            viewportHeight: window.innerHeight,
          };
        })()`);
        throw new Error(
          `${shot.name} selector is not visible in viewport: ${action.selector}. ` +
          `Visibility state: ${JSON.stringify(visibilityState)}`,
        );
      }
      continue;
    }

    if (action.type === 'expectTop') {
      const withinTopBoundary = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        return !!element && element.getBoundingClientRect().top <= ${Number(action.maxTop)};
      })()`, action.timeoutMs ?? 30000);
      if (!withinTopBoundary) {
        const top = await evaluate(client, `document.querySelector(${jsString(action.selector)})?.getBoundingClientRect().top ?? null`);
        throw new Error(
          `${shot.name} selector starts too low: ${action.selector}; ` +
          `top=${top}, expected <= ${Number(action.maxTop)}`,
        );
      }
      continue;
    }

    if (action.type === 'expectCentered') {
      const centered = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const deltaX = Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2);
        const deltaY = Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2);
        return deltaX <= 2 && deltaY <= 2;
      })()`, action.timeoutMs ?? 30000);
      if (!centered) {
        const geometry = await evaluate(client, `(() => {
          const rect = document.querySelector(${jsString(action.selector)})?.getBoundingClientRect();
          return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight } : null;
        })()`);
        throw new Error(`${shot.name} selector is not centered: ${action.selector}; geometry=${JSON.stringify(geometry)}`);
      }
      continue;
    }

    throw new Error(`${shot.name} has unsupported action type: ${action.type}`);
  }
}

async function captureShot(browserPath, baseUrl, shot) {
  const target = new URL(shot.path, baseUrl).toString();
  const output = join(outputDir, `${shot.name}.png`);
  const profile = join(tmpdir(), `rag-screenshot-smoke-${shot.name}-${Date.now()}`);
  const debugPort = await getFreePort();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${shot.width},${shot.height}`,
    target,
  ];

  const browser = spawn(browserPath, args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  browser.stdout.resume();
  browser.stderr.resume();

  let client;
  const runtimeErrors = [];
  try {
    const webSocketUrl = await waitForDevtools(debugPort);
    client = new CdpClient(webSocketUrl);
    await client.open();
    client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
      const description = exceptionDetails?.exception?.description || exceptionDetails?.text;
      if (description) runtimeErrors.push(String(description).slice(0, 1200));
    });
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await setupShotMocks(client, shot);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 1,
      mobile: shot.width <= 480,
    });
    await client.send('Page.navigate', { url: target });
    await waitForReady(client);
    await waitForRouteTransition(client);
    await runShotActions(client, shot);
    await waitForRouteTransition(client);

    const layout = await measureLayout(client);
    if (layout.horizontalOverflow > maxHorizontalOverflowPx) {
      const offenders = layout.visibleElements
        .map((element) => `${element.tag}.${element.className} right=${element.right} text="${element.text}"`)
        .join('; ');
      throw new Error(
        `${shot.name} has ${layout.horizontalOverflow}px horizontal overflow ` +
          `(scrollWidth ${layout.documentScrollWidth}, viewport ${layout.viewportWidth}). ${offenders}`,
      );
    }

    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    writeFileSync(output, screenshot.data, 'base64');
  } catch (error) {
    if (runtimeErrors.length) {
      error.message += ` Runtime errors: ${runtimeErrors.join(' | ')}`;
    }
    throw error;
  } finally {
    client?.close();
    stopProcessTree(browser);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows can keep Chrome profile files locked briefly after taskkill.
    }
  }

  const size = statSync(output).size;
  if (size < minScreenshotBytes) {
    throw new Error(`${shot.name} screenshot is suspiciously small (${size} bytes)`);
  }

  return { output, size };
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_BIN to the browser executable path.');
  }

  mkdirSync(outputDir, { recursive: true });

  let server;
  let baseUrl = process.env.SCREENSHOT_BASE_URL;
  if (!baseUrl) {
    const port = await getFreePort();
    baseUrl = `http://${host}:${port}/`;
    server = startDevServer(port);
  }

  try {
    await waitForServer(baseUrl);
    const requestedShots = new Set(
      String(process.env.SCREENSHOT_SHOTS || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    );
    const selectedShots = requestedShots.size > 0
      ? shots.filter((shot) => requestedShots.has(shot.name))
      : shots;
    if (requestedShots.size > 0 && selectedShots.length !== requestedShots.size) {
      const known = new Set(selectedShots.map((shot) => shot.name));
      const missing = [...requestedShots].filter((name) => !known.has(name));
      throw new Error(`Unknown screenshot names: ${missing.join(', ')}`);
    }
    for (const shot of selectedShots) {
      const result = await captureShot(browserPath, baseUrl, shot);
      console.log(`${shot.name}: ok, ${result.size} bytes -> ${result.output}`);
    }
  } finally {
    stopDevServer(server);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
