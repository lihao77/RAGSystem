import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SMOKE_FILE_REF_FILES } from '../src/utils/smokeFixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const viteBin = resolve(dirname(fileURLToPath(import.meta.resolve('vite'))), '..', '..', 'bin', 'vite.js');
const host = '127.0.0.1';
const outputDir = resolve(rootDir, 'screenshots', 'smoke');
const minScreenshotBytes = 8 * 1024;
const maxHorizontalOverflowPx = 2;

const shots = [
  {
    name: 'session-project-running',
    path: '/?__smoke=empty', width: 1440, height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-session-group__items .session-running' },
      { type: 'expectCount', selector: '.project-session-group__items .session-running', count: 1 },
      { type: 'expectStyle', selector: '.session-running', property: 'width', value: '14px' },
      { type: 'expectStyle', selector: '.session-running', property: 'height', value: '14px' },
      { type: 'expectStyle', selector: '.session-pin-button', property: 'opacity', value: '0' },
      { type: 'expectStyle', selector: '.project-session-group__items > :nth-child(2) .session-leading-slot', property: 'width', value: '22px' },
      { type: 'expectCount', selector: '.project-session-group__items > :nth-child(2) .session-leading-slot .session-running', count: 0 },
      { type: 'expectStyle', selector: '.project-session-group__items', property: 'paddingLeft', value: '0px' },
    ],
  },
  {
    name: 'session-project-hover',
    path: '/?__smoke=empty', width: 1440, height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-session-group__items .session-running' },
      { type: 'hover', selector: '.project-session-group__items > :first-child' },
      { type: 'expectStyle', selector: '.session-leading-status', property: 'opacity', value: '0' },
      { type: 'expectStyle', selector: '.session-pin-button', property: 'opacity', value: '1' },
      { type: 'expectStyle', selector: '.session-pin-button svg', property: 'width', value: '14px' },
      { type: 'expectStyle', selector: '.session-meta', property: 'opacity', value: '0' },
      { type: 'expectStyle', selector: '.session-actions', property: 'opacity', value: '1' },
    ],
  },
  {
    name: 'session-project-mobile',
    path: '/?__smoke=empty', width: 390, height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'click', selector: '[aria-label="打开菜单"]', waitMs: 300 },
      { type: 'expectVisible', selector: '.project-session-group__items .session-leading-slot' },
      { type: 'expectStyle', selector: '.session-running', property: 'width', value: '14px' },
    ],
  },
  {
    name: 'session-pinned-timeline',
    path: '/?__smoke=empty', width: 1440, height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-session-group__items .session-running' },
      { type: 'hover', selector: '.project-session-group__items > :first-child' },
      { type: 'expectStyle', selector: '.project-session-group__items .session-meta', property: 'opacity', value: '0' },
      { type: 'expectStyle', selector: '.project-session-group__items .session-actions', property: 'opacity', value: '1' },
      { type: 'click', selector: '[aria-label="置顶会话"]' },
      { type: 'expectVisible', selector: '.pinned-sessions .session-running' },
      { type: 'expectCount', selector: '.project-session-group__items .session-running', count: 0 },
      { type: 'click', selector: '[aria-label="时间轴视图"]' },
      { type: 'expectVisible', selector: '.pinned-sessions .session-running' },
      { type: 'expectCount', selector: '.session-list-items .session-running', count: 0 },
    ],
  },
  {
    name: 'session-timeline-hover',
    path: '/?__smoke=empty', width: 1440, height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-session-group__items .session-running' },
      { type: 'click', selector: '[aria-label="时间轴视图"]' },
      { type: 'expectVisible', selector: '.session-list-items .session-running' },
      { type: 'hover', selector: '.session-list-items > :first-child' },
      { type: 'expectStyle', selector: '.session-list-items .session-meta', property: 'opacity', value: '0' },
      { type: 'expectStyle', selector: '.session-list-items .session-actions', property: 'opacity', value: '1' },
      { type: 'expectCount', selector: '.session-list-items > :first-child .session-actions button', count: 2 },
      { type: 'expectCount', selector: '.session-list-items .session-leading-slot', count: 0 },
      { type: 'expectCount', selector: '.session-list-items > :first-child .session-actions > :first-child[aria-label="置顶会话"]', count: 1 },
      { type: 'expectStyle', selector: '.session-list-items .session-pin-button', property: 'width', value: '20px' },
      { type: 'expectStyle', selector: '.session-list-items .session-pin-button svg', property: 'width', value: '14px' },
    ],
  },
  {
    name: 'session-timeline-pin',
    path: '/?__smoke=empty', width: 1440, height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-session-group__items .session-running' },
      { type: 'click', selector: '[aria-label="时间轴视图"]' },
      { type: 'expectVisible', selector: '.session-list-items .session-running' },
      { type: 'hover', selector: '.session-list-items > :first-child' },
      { type: 'click', selector: '.session-list-items .session-pin-button' },
      { type: 'expectVisible', selector: '.pinned-sessions .session-running' },
      { type: 'expectCount', selector: '.session-list-items .session-running', count: 0 },
      { type: 'click', selector: '[aria-label="项目视图"]' },
      { type: 'expectVisible', selector: '.pinned-sessions .session-running' },
      { type: 'expectCount', selector: '.project-session-group__items .session-running', count: 0 },
      { type: 'click', selector: '.pinned-sessions [aria-label="取消置顶"]' },
      { type: 'expectVisible', selector: '.project-session-group__items .session-running' },
      { type: 'expectCount', selector: '.pinned-sessions', count: 0 },
    ],
  },
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
      { type: 'expectStyle', selector: '.project-trigger', property: 'borderRadius', value: '999px' },
      { type: 'expectVisible', selector: '.project-trigger' },
      // 列表加载完成前触发器是 disabled，点了也不会开；等标签落到已选项目再点
      { type: 'expectText', selector: '.project-trigger', text: 'ragsystem' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectText', selector: '.project-picker-popover', text: 'ZCodeProject' },
      { type: 'click', selector: '.project-list > li:last-child .project-option' },
      { type: 'expectHidden', selector: '.project-picker-popover' },
      { type: 'expectText', selector: '.session-setup-panel', text: 'ZCodeProject' },
    ],
  },
  {
    name: 'start-page-project-pill-cjk',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-trigger' },
      // 列表加载完成前触发器是 disabled，点了也不会开；等标签落到已选项目再点
      { type: 'expectText', selector: '.project-trigger', text: 'ragsystem' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectVisible', selector: '.project-list > li:nth-child(2) .project-option' },
      { type: 'click', selector: '.project-list > li:nth-child(2) .project-option' },
      { type: 'expectText', selector: '.session-setup-panel', text: '南海供水' },
      { type: 'expectHidden', selector: '.project-picker-popover' },
    ],
  },
  {
    name: 'start-page-project-dropdown-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-trigger' },
      // 列表加载完成前触发器是 disabled，点了也不会开；等标签落到已选项目再点
      { type: 'expectText', selector: '.project-trigger', text: 'ragsystem' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectVisible', selector: '.project-picker-popover input[aria-label="搜索项目"]' },
      { type: 'expectText', selector: '.project-picker-popover .project-list', text: 'ZCodeProject' },
      { type: 'expectText', selector: '.project-picker-actions', text: '不指定项目' },
      // 搜索框就地过滤列表，不改变动作区
      { type: 'setValue', selector: '.project-picker-popover input[aria-label="搜索项目"]', value: 'ZCode' },
      { type: 'expectCount', selector: '.project-list .project-option', count: 1 },
      { type: 'expectText', selector: '.project-list', text: 'ZCodeProject' },
    ],
  },
  {
    name: 'start-page-project-dropdown-mobile',
    path: '/?__smoke=empty',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.project-trigger' },
      // 列表加载完成前触发器是 disabled，点了也不会开；等标签落到已选项目再点
      { type: 'expectText', selector: '.project-trigger', text: 'ragsystem' },
      { type: 'click', selector: '.project-trigger' },
      { type: 'expectVisible', selector: '.project-picker-popover .project-list .project-option' },
      { type: 'expectVisible', selector: '.project-picker-actions .project-option' },
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
      { type: 'click', selector: 'button[title="展开执行过程"]', waitMs: 300 },
      { type: 'expectText', selector: '.message-stream', text: '读取监测数据并生成趋势图。' },
      { type: 'expectVisible', selector: 'button[title="收起执行过程"]' },
    ],
  },
  {
    name: 'chat-consecutive-input-execution',
    path: '/?__smoke=artifact&__consecutive=1',
    width: 960,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '.message.user:nth-child(1):not(.message--has-execution)' },
      { type: 'expectVisible', selector: '.message.user:nth-child(2):not(.message--has-execution)' },
      { type: 'expectVisible', selector: '.message.user:nth-child(3) .assistant-execution-toggle' },
      { type: 'expectVisible', selector: '.message.assistant:not(.message--has-execution)' },
      { type: 'click', selector: 'button[title="展开执行过程"]', waitMs: 300 },
      { type: 'expectText', selector: '.message.user:nth-child(3)', text: '读取监测数据并生成趋势图。' },
    ],
  },
  ...[960, 390].map((width) => ({
    name: `chat-followup-editor-${width === 390 ? 'mobile' : 'desktop'}`,
    path: '/?__smoke=artifact&__pendingFollowup=1',
    width,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '.pending-followups' },
      { type: 'click', selector: '[aria-label="编辑待处理消息"]' },
      { type: 'expectValue', selector: 'textarea', value: '请先检查异常站点，再补充最近一周的数据。' },
    ],
  })),
  {
    name: 'chat-followup-edit-delete',
    path: '/?__smoke=artifact&__pendingFollowup=1',
    width: 960,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '.pending-followups' },
      { type: 'click', selector: '[aria-label="编辑待处理消息"]' },
      { type: 'expectValue', selector: 'textarea', value: '请先检查异常站点，再补充最近一周的数据。' },
    ],
  },
  ...[960, 390].map((width) => ({
    name: `chat-pending-followups-${width === 390 ? 'mobile' : 'desktop'}`,
    path: '/?__smoke=artifact&__pendingFollowup=1',
    width,
    height: 900,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '.chat-input-area--queued .composer-pending .pending-followups' },
      { type: 'expectText', selector: '.pending-followups', text: '请先检查异常站点，再补充最近一周的数据。' },
      { type: 'expectText', selector: '.pending-followups', text: '等待处理' },
      { type: 'expectText', selector: '.pending-followups', text: '发送中…' },
      { type: 'expectVisible', selector: '.chat-input-area--queued textarea[placeholder="继续输入以排队/后续修改"]' },
      { type: 'expectVisible', selector: '.input-area-wrapper' },
    ],
  })),
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
      { type: 'expectText', selector: '.runtime-center-head__subtitle', text: '持续目标与后台任务' },
      { type: 'expectVisible', selector: '.runtime-overview' },
    ],
  },
  {
    name: 'chat-fileref-desktop',
    path: '/?__smoke=fileref',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockFileRefApi' },
      { type: 'expectText', selector: '.message-stream', text: 'file_ref 三种 presentation 的渲染矩阵' },
      // inline 图片 + preview 缩略图（caption 文本断言，避免视口外误报）
      { type: 'expectText', selector: '.message-stream', text: '站点实拍（inline 内联图）' },
      { type: 'expectText', selector: '.message-stream', text: '预警分布图（preview 缩略图）' },
      // inline 外壳内容（markdown/csv/py）
      { type: 'expectText', selector: '.message-stream', text: '监测周报（摘要）' },
      { type: 'expectText', selector: '.message-stream', text: '站点-1' },
      { type: 'expectText', selector: '.message-stream', text: 'WARN_THRESHOLD' },
      { type: 'expectText', selector: '.file-csv-table__foot', text: '共 15 行' },
      // preview 卡片
      { type: 'expectText', selector: '.message-stream', text: '指标汇总（preview JSON）' },
      // attachment 下载卡片（排除 preview 可点击卡片）
      { type: 'expectText', selector: '.workspace-file-card:not(.workspace-file-card--clickable)', text: 'raw-export.csv' },
      // 交互图表（ECharts）：header 标题（caption）+ canvas 真实渲染（echarts.init 后 canvas 像素尺寸非零；
      // option.title 画在 canvas 内，不属于 DOM 文本，故断言头部 caption 而非图表内标题）
      { type: 'expectText', selector: '.message-stream', text: '水位趋势（inline 交互图表）' },
      { type: 'expectText', selector: '.chart-renderer', text: '水位趋势（inline 交互图表）' },
      { type: 'expectCanvas', selector: '.chart-container canvas' },
      // 图片真实解码校验（防止坏图夹具静默通过文本断言）
      { type: 'expectImagesDecoded', selector: '.message-stream' },
    ],
  },
  {
    name: 'chat-fileref-preview-dialog',
    path: '/?__smoke=fileref',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockFileRefApi' },
      { type: 'expectText', selector: '.message-stream', text: '指标汇总（preview JSON）' },
      { type: 'click', selector: '.workspace-file-card--clickable', waitMs: 600 },
      { type: 'expectVisible', selector: '[role="dialog"]' },
      { type: 'expectText', selector: '[role="dialog"]', text: '指标汇总（preview JSON）' },
      { type: 'expectText', selector: '[role="dialog"]', text: 'mean_level' },
    ],
  },
  {
    name: 'chat-fileref-lightbox',
    path: '/?__smoke=fileref',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockFileRefApi' },
      { type: 'expectText', selector: '.message-stream', text: '站点实拍（inline 内联图）' },
      { type: 'click', selector: '.fallback-image', waitMs: 600 },
      { type: 'expectVisible', selector: '.image-lightbox' },
      { type: 'expectText', selector: '.image-lightbox__title', text: '站点实拍' },
      { type: 'expectImagesDecoded', selector: '.image-lightbox' },
    ],
  },
  {
    name: 'chat-fileref-mobile',
    path: '/?__smoke=fileref',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockFileRefApi' },
      { type: 'expectText', selector: '.message-stream', text: '监测周报（摘要）' },
      { type: 'expectText', selector: '.message-stream', text: '指标汇总（preview JSON）' },
      { type: 'expectImagesDecoded', selector: '.message-stream' },
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
  const mockKnowledgeSearchApi = (shot.actions || []).some(action => action.type === 'mockKnowledgeSearchApi');
  const mockSessionSidebarApi = (shot.actions || []).some(action => action.type === 'mockSessionSidebarApi');
  const mockFileRefApi = (shot.actions || []).some(action => action.type === 'mockFileRefApi');
  if (!mockArtifactApi && !mockKnowledgeSearchApi && !mockSessionSidebarApi && !mockFileRefApi) return;

  await client.send('Fetch.enable', {
    patterns: [
      ...(mockArtifactApi ? [
        {
          urlPattern: '*://*/api/agent/sessions/smoke-artifact-session/message-requests*',
          requestStage: 'Request',
        },
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
      ...(mockFileRefApi ? [
        {
          urlPattern: '*://*/api/agent/sessions/smoke-fileref-session/workspace-files/content*',
          requestStage: 'Request',
        },
      ] : []),
    ],
  });

  let pendingReceipt = { request_id: 'smoke-followup-1', content: '请先检查异常站点，再补充最近一周的数据。', status: 'queued', can_manage: true, error: null, message_id: null, updated_at: '' };
  client.on('Fetch.requestPaused', async (event) => {
    if (mockArtifactApi && event.request?.url?.includes('/smoke-artifact-session/message-requests')) {
      const method = event.request.method;
      if (method === 'DELETE') pendingReceipt = { ...pendingReceipt, status: 'cancelled', can_manage: false };
      const data = method === 'GET'
        ? { items: shot.path.includes('__pendingFollowup=1') && pendingReceipt.status !== 'cancelled' ? [pendingReceipt] : [] }
        : { item: pendingReceipt };
      await client.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: Buffer.from(JSON.stringify({ success: true, message: '', data }), 'utf8').toString('base64') });
      return;
    }
    if (mockFileRefApi && event.request?.url?.includes('/api/agent/sessions/smoke-fileref-session/workspace-files/content')) {
      const requestUrl = new URL(event.request.url);
      const filePath = requestUrl.searchParams.get('path') || '';
      const file = SMOKE_FILE_REF_FILES[filePath];
      if (!file) {
        await client.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: 404,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(JSON.stringify({ detail: '文件不存在或已过期' }), 'utf8').toString('base64'),
        });
        return;
      }
      const bodyBase64 = file.base64 ? file.body : Buffer.from(file.body, 'utf8').toString('base64');
      await client.send('Fetch.fulfillRequest', {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: file.contentType },
          { name: 'Content-Length', value: String(Buffer.from(bodyBase64, 'base64').length) },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: bodyBase64,
      });
      return;
    }
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
      // 中文项目名：胶囊标签的 overflow:hidden 曾把字形上下切掉，用它守住回归
      const workspaceCjk = {
        workspace_id: 'ws-cjk',
        display_name: '南海供水',
        root_path: 'D:/projects/南海供水',
      };
      let responseData = null;
      if (requestUrl.pathname === '/api/agent/workspaces') {
        responseData = {
          items: [
            { ...workspaceRagsystem, session_count: 3 },
            { ...workspaceCjk, session_count: 0 },
            { ...workspaceZcode, session_count: 0 },
          ],
        };
      } else if (requestUrl.pathname === '/api/agent/sessions/facets') {
        responseData = {
          type_counts: { direct: 3, bot: 0, widget: 0 },
          origins: [],
          workspaces: [
            { ...workspaceRagsystem, count: 3 },
            { ...workspaceCjk, count: 0 },
            { ...workspaceZcode, count: 0 },
          ],
        };
      } else if (['/api/agent/sessions', '/api/agent/sessions/workspace-preview', '/api/agent/sessions/states'].includes(requestUrl.pathname)) {
        const origin = { type: 'direct', id: null, display_name: '直接对话', channel: 'web' };
        responseData = {
          items: [
            {
              session_id: 'session-host-mcp',
              runtime_state: 'running',
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
        if (requestUrl.pathname.endsWith('/workspace-preview')) {
          responseData = { groups: [
            { workspace_id: workspaceRagsystem.workspace_id, ...responseData },
            { workspace_id: workspaceZcode.workspace_id, items: [], next_cursor: null },
            { workspace_id: '__unassigned__', items: [], next_cursor: null },
          ] };
        } else if (requestUrl.pathname.endsWith('/states')) {
          const ids = JSON.parse(event.request.postData || '{}').session_ids || [];
          responseData = { items: responseData.items.filter(item => ids.includes(item.session_id)).map(item => ({ session_id: item.session_id, state: item.runtime_state || 'idle' })) };
        } else if (requestUrl.searchParams.has('session_ids')) {
          const ids = JSON.parse(requestUrl.searchParams.get('session_ids'));
          responseData.items = responseData.items.filter(item => ids.includes(item.session_id));
        }
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
    if (action.type === 'mockArtifactApi' || action.type === 'mockKnowledgeSearchApi' || action.type === 'mockSessionSidebarApi' || action.type === 'mockFileRefApi') {
      continue;
    }

    if (action.type === 'hover') {
      const point = await evaluate(client, `(() => {
        const rect = document.querySelector(${jsString(action.selector)})?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
      })()`);
      if (!point) throw new Error(`${shot.name} could not find hover selector: ${action.selector}`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await wait(250);
      continue;
    }

    if (action.type === 'expectStyle' || action.type === 'expectCount') {
      const expression = action.type === 'expectCount'
        ? `document.querySelectorAll(${jsString(action.selector)}).length === ${action.count}`
        : `(() => { const element = document.querySelector(${jsString(action.selector)}); return element && getComputedStyle(element)[${jsString(action.property)}] === ${jsString(action.value)}; })()`;
      if (!await waitForEvaluation(client, expression, 5000)) {
        const detail = await evaluate(client, `document.querySelectorAll(${jsString(action.selector)}).length`);
        throw new Error(`${shot.name} failed ${action.type} for ${action.selector}: ${detail}`);
      }
      continue;
    }

    if (action.type === 'expectImagesDecoded') {
      const decoded = await waitForEvaluation(client, `(() => {
        const root = document.querySelector(${jsString(action.selector)});
        const images = root ? [...root.querySelectorAll('img')] : [];
        return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
      })()`, action.timeoutMs ?? 30000);
      if (!decoded) {
        const state = await evaluate(client, `(() => {
          const root = document.querySelector(${jsString(action.selector)});
          const images = root ? [...root.querySelectorAll('img')] : [];
          return images.map((image) => ({ src: String(image.src).slice(0, 80), complete: image.complete, naturalWidth: image.naturalWidth }));
        })()`);
        throw new Error(`${shot.name} images did not decode: ${JSON.stringify(state)}`);
      }
      continue;
    }

    if (action.type === 'expectCanvas') {
      const rendered = await waitForEvaluation(client, `(() => {
        const canvas = document.querySelector(${jsString(action.selector)});
        if (!canvas) return false;
        return canvas.width >= ${action.minWidth ?? 200} && canvas.height >= ${action.minHeight ?? 100};
      })()`, action.timeoutMs ?? 30000);
      if (!rendered) {
        const state = await evaluate(client, `(() => {
          const canvas = document.querySelector(${jsString(action.selector)});
          return canvas ? { width: canvas.width, height: canvas.height } : null;
        })()`);
        throw new Error(`${shot.name} canvas did not render: ${JSON.stringify(state)}`);
      }
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

    if (action.type === 'expectValue') {
      const matched = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        return !!element && String(element.value ?? '') === ${jsString(action.value)};
      })()`, action.timeoutMs ?? 30000);
      if (!matched) throw new Error(`${shot.name} value mismatch: ${action.selector}`);
      continue;
    }

    if (action.type === 'expectHidden') {
      const hidden = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return true;
        const rect = element.getBoundingClientRect();
        return rect.width === 0 || rect.height === 0 || getComputedStyle(element).display === 'none';
      })()`, action.timeoutMs ?? 30000);
      if (!hidden) throw new Error(`${shot.name} selector is still visible: ${action.selector}`);
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
