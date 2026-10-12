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
      { type: 'click', selector: '.sidebar-menu-trigger', waitMs: 300 },
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
      // 空态的输入区浮在页面中间，底部带不能刷底色（否则露出一块矩形）
      { type: 'expectExpression',
        script: "const bg = getComputedStyle(document.querySelector('.input-area-wrapper')).backgroundColor; return bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent'",
        detail: "return getComputedStyle(document.querySelector('.input-area-wrapper')).backgroundColor;" },
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
      // 菜单首项是「重命名项目」，这里按顺序取第二项「移除项目」（按文案取会让脚本
      // 在 i18n/文案微调时误报，按序取能守住"两项并列"的结构约定）。
      { type: 'click', selector: '[role="menu"] [role="group"] > [role="menuitem"]:nth-child(2)' },
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
      { type: 'click', selector: '.sidebar-menu-trigger', waitMs: 300 },
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
      { type: 'click', selector: '.sidebar-menu-trigger', waitMs: 300 },
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
      { type: 'click', selector: '.sidebar-menu-trigger', waitMs: 300 },
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
      // 容器不得再加 gap：flex 下它不与子项 margin-top 折叠，会让移动端间距反而变大
      { type: 'expectStyle', selector: '.message-stream', property: 'rowGap', value: 'normal' },
      // 段内紧凑间距（带执行的 user → 紧随的 assistant）在移动端必须是 6px：
      // 容器若加了 gap，这里会先变成 14px（即 20+8=28 的老问题）
      { type: 'expectStyle', selector: '.message-stream > * + *', property: 'marginTop', value: '6px' },
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
    // 浅色下的执行行（intent / 工具调用）对比度回归
    name: 'chat-consecutive-input-execution-light',
    path: '/?__smoke=artifact&__consecutive=1',
    width: 960,
    height: 900,
    theme: 'light',
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '.message.user:nth-child(3) .assistant-execution-toggle' },
      { type: 'click', selector: 'button[title="展开执行过程"]', waitMs: 300 },
      { type: 'expectText', selector: '.message.user:nth-child(3)', text: '读取监测数据并生成趋势图。' },
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
    name: 'chat-short-viewport-desktop',
    path: '/?__smoke=artifact',
    width: 1280,
    height: 600,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'click', selector: 'button[title="展开执行过程"]', waitMs: 300 },
      // 矮窗口下细节块上限走 vh 兜底：26vh × 600 = 156 < 160，说明生效的是 min(160px, 26vh)
      { type: 'expectStyle', selector: '.tool-call-detail-text.is-mono', property: 'maxHeight', value: '156px' },
    ],
  },
  {
    name: 'chat-scroll-follow-desktop',
    // 用连发输入的多消息夹具 + 矮窗口才滚得起来（基础夹具 1440×900 下 scrollHeight === clientHeight）。
    // 该夹具加载后停在顶部，所以先手动落到底部构造「跟随态」起点。
    path: '/?__smoke=artifact&__consecutive=1',
    width: 1440,
    height: 620,
    actions: [
      { type: 'mockArtifactApi' },
      { type: 'expectVisible', selector: '.message-stream' },
      { type: 'expectExpression',
        script: "const w = document.querySelector('.chat-messages-wrapper'); return w.scrollHeight > w.clientHeight + 40",
        detail: "const w = document.querySelector('.chat-messages-wrapper'); return { scrollTop: w.scrollTop, scrollHeight: w.scrollHeight, clientHeight: w.clientHeight };" },
      // 落到底部 = 跟随态：不显示「滚动到底部」
      { type: 'scrollToBottom', selector: '.chat-messages-wrapper' },
      { type: 'expectCount', selector: '.scroll-to-bottom-btn', count: 0 },
      // 上滚 → 脱离跟随，按钮出现
      { type: 'scrollToTop', selector: '.chat-messages-wrapper' },
      { type: 'expectVisible', selector: '.scroll-to-bottom-btn' },
      // 点按钮 → 平滑回到底部并恢复跟随，按钮消失（覆盖 scroll-behavior: smooth 生效）
      { type: 'click', selector: '.scroll-to-bottom-btn' },
      { type: 'expectExpression',
        script: "const w = document.querySelector('.chat-messages-wrapper'); return Math.max(0, w.scrollHeight - w.scrollTop - w.clientHeight) <= 4",
        detail: "const w = document.querySelector('.chat-messages-wrapper'); return { scrollTop: w.scrollTop, scrollHeight: w.scrollHeight, clientHeight: w.clientHeight };" },
      { type: 'expectCount', selector: '.scroll-to-bottom-btn', count: 0 },
      // 底部带与聊天区同色：卡片只挡住自己那块，这条带不实心的话正文会从卡片下方露出来。
      // 三卡片外壳下"聊天区"就是对话卡本身（.chat-conversation-column），外壳容器是透明的。
      { type: 'expectExpression',
        script: "const el = document.querySelector('.input-area-wrapper'); const card = document.querySelector('.chat-conversation-column'); return !!card && getComputedStyle(el).backgroundColor === getComputedStyle(card).backgroundColor",
        detail: "const el = document.querySelector('.input-area-wrapper'); const card = document.querySelector('.chat-conversation-column'); return { wrapperBg: getComputedStyle(el).backgroundColor, cardBg: card ? getComputedStyle(card).backgroundColor : null };" },
      // 收尾停在「正文从输入框身后经过」的位置，截屏用于肉眼核对底部没有露字
      { type: 'scrollToTop', selector: '.chat-messages-wrapper' },
    ],
  },
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
      // 运行中的补充消息可以带附件（send_followup 与 send_message 同权），附件入口不得置灰。
      {
        type: 'expectExpression',
        script: 'const button = document.querySelector(\'[aria-label="添加图片或文件"]\'); return !!button && !button.disabled;',
        detail: 'const button = document.querySelector(\'[aria-label="添加图片或文件"]\'); return button ? { disabled: button.disabled } : "(附件入口不存在)";',
      },
    ],
  })),
  {
    name: 'chat-mobile-runtime-execution',
    path: '/?__smoke=artifact',
    width: 390,
    height: 844,
    actions: [
      { type: 'mockArtifactApi' },
      // 运行概览住在右侧工作台卡：窄屏是抽屉形态，先展开再断言内容
      { type: 'expectVisible', selector: '[aria-label="展开运行工作台"]' },
      { type: 'click', selector: '[aria-label="展开运行工作台"]', waitMs: 400 },
      { type: 'expectVisible', selector: '.run-workbench__card' },
      { type: 'expectText', selector: '.rw-agents', text: '智能体' },
      { type: 'expectVisible', selector: '.runtime-overview' },
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
      // 运行概览在右侧工作台卡里（表头只留展开入口）
      { type: 'expectVisible', selector: '[aria-label="展开运行工作台"]' },
      { type: 'click', selector: '[aria-label="展开运行工作台"]', waitMs: 300 },
      { type: 'expectVisible', selector: '.run-workbench__card' },
      { type: 'expectVisible', selector: '.runtime-overview' },
      // 工作台切换的收起/展开按钮落在同一竖槽（都以卡右缘+6px 为锚），切换不横跳：
      // 先记下展开态收起按钮的右缘，收起后再量展开入口的右缘，两者应重合。
      { type: 'expectVisible', selector: '[aria-label="收起运行工作台"]' },
      { type: 'expectExpression',
        script: "const btn = document.querySelector('[aria-label=\"收起运行工作台\"]'); if (!btn) return false; window.__toggleSlot = btn.getBoundingClientRect().right; return true;",
        detail: "const btn = document.querySelector('[aria-label=\"收起运行工作台\"]'); return btn ? { collapseRight: btn.getBoundingClientRect().right } : '(收起按钮不存在)';" },
      { type: 'click', selector: '[aria-label="收起运行工作台"]', waitMs: 400 },
      { type: 'expectVisible', selector: '[aria-label="展开运行工作台"]' },
      { type: 'expectExpression',
        script: "const btn = document.querySelector('[aria-label=\"展开运行工作台\"]'); if (!btn || !window.__toggleSlot) return false; return Math.abs(btn.getBoundingClientRect().right - window.__toggleSlot) <= 1;",
        detail: "const btn = document.querySelector('[aria-label=\"展开运行工作台\"]'); return { expandRight: btn?.getBoundingClientRect().right ?? null, collapseRight: window.__toggleSlot ?? null };" },
    ],
  },
  {
    // 三卡片外壳：侧栏与窗口同色（不铺卡片），对话卡与运行工作台卡各是一张圆角卡，
    // 卡间缝宽度 = 外壳内边距 = 工作台分隔条宽度。
    name: 'chat-three-card-shell-desktop',
    path: '/?__smoke=participants',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectVisible', selector: '.chat-conversation-column' },
      { type: 'expectVisible', selector: '.run-workbench__card' },
      { type: 'expectExpression',
        script: "const shell = document.querySelector('.chat-layout'); const sidebar = document.querySelector('.sidebar'); const card = document.querySelector('.chat-conversation-column'); if (!shell || !sidebar || !card) return false; const gap = parseFloat(getComputedStyle(shell).paddingLeft); const side = sidebar.getBoundingClientRect(); const rect = card.getBoundingClientRect(); return gap > 0 && gap <= 12 && getComputedStyle(sidebar).backgroundColor === getComputedStyle(shell).backgroundColor && Math.abs((rect.left - side.right) - gap) <= 1",
        detail: "const shell = document.querySelector('.chat-layout'); const sidebar = document.querySelector('.sidebar'); const card = document.querySelector('.chat-conversation-column'); const gap = parseFloat(getComputedStyle(shell).paddingLeft); const side = sidebar.getBoundingClientRect(); const rect = card.getBoundingClientRect(); return { gap, seam: rect.left - side.right, sidebarBg: getComputedStyle(sidebar).backgroundColor, shellBg: getComputedStyle(shell).backgroundColor };" },
      { type: 'expectStyle', selector: '.chat-conversation-column', property: 'borderRadius', value: '12px' },
      { type: 'expectStyle', selector: '.run-workbench__card', property: 'borderRadius', value: '12px' },
      { type: 'expectExpression',
        script: "const card = document.querySelector('.chat-conversation-column'); const workbench = document.querySelector('.run-workbench__card'); const handle = document.querySelector('.run-workbench-resize'); if (!card || !workbench || !handle) return false; const gap = parseFloat(getComputedStyle(document.querySelector('.chat-layout')).paddingLeft); const cardRect = card.getBoundingClientRect(); const workbenchRect = workbench.getBoundingClientRect(); return Math.abs(handle.getBoundingClientRect().width - gap) <= 1 && Math.abs(workbenchRect.left - cardRect.right - gap) <= 1 && getComputedStyle(workbench).backgroundColor === getComputedStyle(card).backgroundColor",
        detail: "const card = document.querySelector('.chat-conversation-column'); const workbench = document.querySelector('.run-workbench__card'); const handle = document.querySelector('.run-workbench-resize'); const cardRect = card?.getBoundingClientRect(); const workbenchRect = workbench?.getBoundingClientRect(); return { handleWidth: handle?.getBoundingClientRect().width ?? null, seam: workbenchRect && cardRect ? workbenchRect.left - cardRect.right : null, cardBg: card ? getComputedStyle(card).backgroundColor : null, workbenchBg: workbench ? getComputedStyle(workbench).backgroundColor : null };" },
      { type: 'expectText', selector: '.rw-agents', text: '水位分析' },
      // 分隔条悬停只是"这里可以拖"的提示：亮一档的边框色，不用品牌强调色
      // （缝一直在鼠标路径上，亮线在卡片之间过于抢眼）。
      { type: 'hover', selector: '.run-workbench-resize' },
      { type: 'expectExpression',
        script: "const handle = document.querySelector('.run-workbench-resize'); if (!handle) return false; const probe = document.createElement('span'); probe.style.background = 'var(--color-border-hover)'; document.body.appendChild(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove(); return getComputedStyle(handle, '::after').backgroundColor === expected",
        detail: "const handle = document.querySelector('.run-workbench-resize'); const probe = document.createElement('span'); probe.style.background = 'var(--color-border-hover)'; document.body.appendChild(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove(); const r = handle?.getBoundingClientRect(); const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null; return { hovered: handle?.matches(':hover') ?? null, rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null, hit: hit ? hit.className || hit.tagName : null, hoverLine: handle ? getComputedStyle(handle, '::after').backgroundColor : null, borderHover: expected };" },
    ],
  },
  {
    // 子智能体线程只进第三张卡：主对话列始终是根会话
    name: 'chat-workbench-thread-desktop',
    path: '/?__smoke=participants&__tab=child-1',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectVisible', selector: '.rw-thread' },
      { type: 'expectText', selector: '.rw-tab.is-active', text: '水位分析' },
      { type: 'expectText', selector: '.rw-thread', text: '统计近一周的日均水位' },
      { type: 'expectText', selector: '.rw-thread', text: '近一周日均水位 12.4m' },
      { type: 'expectText', selector: '.chat-conversation-column', text: '让子智能体写一份小结' },
      { type: 'expectCount', selector: '.chat-conversation-column .rw-thread', count: 0 },
      { type: 'expectCount', selector: '.rw-tab', count: 2 },
    ],
  },
  {
    // 入口之二：执行过程里的委派行 → 展开详情 → 在运行工作台打开该子智能体的线程
    name: 'chat-workbench-open-from-delegation-desktop',
    path: '/?__smoke=participants',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectText', selector: '.chat-conversation-column', text: '让子智能体写一份小结' },
      { type: 'click', selector: '.rw-collapse' },
      { type: 'expectHidden', selector: '.run-workbench' },
      { type: 'click', selector: '.assistant-step-row.is-agent' },
      { type: 'expectVisible', selector: '.assistant-step-thread-link' },
      { type: 'click', selector: '.assistant-step-thread-link' },
      { type: 'expectVisible', selector: '.rw-thread' },
      { type: 'expectText', selector: '.rw-tab.is-active', text: '水位分析' },
      { type: 'expectText', selector: '.rw-thread', text: '近一周日均水位 12.4m' },
    ],
  },
  {
    // 收起/展开：面板收起后入口落在对话卡表头，展开回到同一条线程
    name: 'chat-workbench-collapse-desktop',
    path: '/?__smoke=participants&__tab=child-1',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectVisible', selector: '.rw-thread' },
      { type: 'click', selector: '.rw-collapse' },
      // 面板收起：整列宽度归零，省下的宽度还给对话卡（卡片回到外壳右内边距处）
      { type: 'expectHidden', selector: '.run-workbench' },
      { type: 'expectExpression',
        script: "const card = document.querySelector('.chat-conversation-column'); const shell = document.querySelector('.chat-layout'); if (!card || !shell) return false; const gap = parseFloat(getComputedStyle(shell).paddingLeft); return Math.abs((window.innerWidth - gap) - card.getBoundingClientRect().right) <= 1",
        detail: "const card = document.querySelector('.chat-conversation-column'); const shell = document.querySelector('.chat-layout'); return { cardRight: card?.getBoundingClientRect().right ?? null, expected: window.innerWidth - parseFloat(getComputedStyle(shell).paddingLeft) };" },
      { type: 'click', selector: '[aria-label="展开运行工作台"]' },
      { type: 'expectVisible', selector: '.rw-thread' },
      { type: 'expectText', selector: '.rw-tab.is-active', text: '水位分析' },
    ],
  },
  {
    // 收起动画是"整卡向右划出屏幕"：卡片定宽锚在外层左缘，外层收窄把卡片连内容一起推向右缘裁掉。
    // 收起后：外层归零、卡片布局宽不变（文字不换行挤压）、卡片左缘已推到外壳右内边距处（移出而非被盖住）。
    name: 'chat-workbench-collapse-slide-desktop',
    path: '/?__smoke=participants&__tab=child-1',
    width: 1440,
    height: 900,
    actions: [
      { type: 'expectVisible', selector: '.rw-thread' },
      { type: 'expectExpression',
        // 宽度取 computed 布局宽（getBoundingClientRect 会被路由进场的 scale(0.99) 过渡污染，偶发抖动）
        script: "const card = document.querySelector('.run-workbench__card'); if (!card) return false; window.__workbenchCardWidth = parseFloat(getComputedStyle(card).width); window.__workbenchCardLeft = card.getBoundingClientRect().left; return window.__workbenchCardWidth >= 360;",
        detail: "const card = document.querySelector('.run-workbench__card'); return { cardWidth: card ? getComputedStyle(card).width : null, cardLeft: card?.getBoundingClientRect().left ?? null };" },
      { type: 'click', selector: '.rw-collapse', waitMs: 400 },
      { type: 'expectHidden', selector: '.run-workbench' },
      { type: 'expectExpression',
        script: "const aside = document.querySelector('.run-workbench'); const card = document.querySelector('.run-workbench__card'); const shell = document.querySelector('.chat-layout'); if (!aside || !card || !shell) return false; const gap = parseFloat(getComputedStyle(shell).paddingLeft); const rect = card.getBoundingClientRect(); const slidOut = rect.left - window.__workbenchCardLeft; return aside.getBoundingClientRect().width === 0 && Math.abs(parseFloat(getComputedStyle(card).width) - window.__workbenchCardWidth) <= 1 && Math.abs(rect.left - (window.innerWidth - gap)) <= 1 && slidOut > 100;",
        detail: "const aside = document.querySelector('.run-workbench'); const card = document.querySelector('.run-workbench__card'); const shell = document.querySelector('.chat-layout'); const gap = shell ? parseFloat(getComputedStyle(shell).paddingLeft) : null; const rect = card?.getBoundingClientRect(); return { asideWidth: aside?.getBoundingClientRect().width ?? null, cardWidth: card ? getComputedStyle(card).width : null, cardLeft: rect?.left ?? null, openCardLeft: window.__workbenchCardLeft ?? null, expectedLeft: gap != null ? window.innerWidth - gap : null };" },
    ],
  },
  {
    // 侧栏折叠 = 整栏定宽向左滑出（与运行工作台的整卡滑出互为镜像）：
    // 折叠后宽度不变（内容零形变）、左缘出屏（负位移），主体区左缘顶到外壳内边距处；
    // 展开后整栏滑回原位。宽度若退回 width:0 收缩（文字被压窄换行），这里的宽度差会立刻暴露。
    name: 'sidebar-collapse-slide-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.sidebar' },
      { type: 'expectText', selector: '.sidebar', text: '新聊天' },
      { type: 'expectExpression',
        // 宽度取 computed 布局宽（getBoundingClientRect 会被路由进场的 scale(0.99) 过渡污染，偶发抖动）
        script: "const bar = document.querySelector('.sidebar'); if (!bar) return false; window.__sidebarWidth = parseFloat(getComputedStyle(bar).width); window.__sidebarLeft = bar.getBoundingClientRect().left; return window.__sidebarWidth >= 200 && window.__sidebarLeft >= 0;",
        detail: "const bar = document.querySelector('.sidebar'); return { sidebarWidth: bar ? getComputedStyle(bar).width : null, sidebarLeft: bar?.getBoundingClientRect().left ?? null };" },
      { type: 'click', selector: '[aria-label="折叠侧栏"]', waitMs: 400 },
      { type: 'expectExpression',
        script: "const bar = document.querySelector('.sidebar'); const host = document.querySelector('.layout-main-host'); const shell = document.querySelector('.chat-layout'); if (!bar || !host || !shell) return false; const gap = parseFloat(getComputedStyle(shell).paddingLeft); const rect = bar.getBoundingClientRect(); return Math.abs(parseFloat(getComputedStyle(bar).width) - window.__sidebarWidth) <= 1 && rect.left <= -200 && Math.abs(host.getBoundingClientRect().left - gap) <= 1;",
        detail: "const bar = document.querySelector('.sidebar'); const host = document.querySelector('.layout-main-host'); const shell = document.querySelector('.chat-layout'); return { sidebarWidth: bar ? getComputedStyle(bar).width : null, sidebarLeft: bar?.getBoundingClientRect().left ?? null, openSidebarWidth: window.__sidebarWidth ?? null, mainHostLeft: host?.getBoundingClientRect().left ?? null, shellGap: shell ? parseFloat(getComputedStyle(shell).paddingLeft) : null };" },
      { type: 'click', selector: '[aria-label="展开侧栏"]', waitMs: 400 },
      { type: 'expectExpression',
        script: "const bar = document.querySelector('.sidebar'); if (!bar) return false; const rect = bar.getBoundingClientRect(); return Math.abs(parseFloat(getComputedStyle(bar).width) - window.__sidebarWidth) <= 1 && Math.abs(rect.left - window.__sidebarLeft) <= 1;",
        detail: "const bar = document.querySelector('.sidebar'); return { sidebarWidth: bar ? getComputedStyle(bar).width : null, sidebarLeft: bar?.getBoundingClientRect().left ?? null, expectedLeft: window.__sidebarLeft ?? null };" },
    ],
  },
  {
    // 窄屏：工作台退化为右侧抽屉，不参与三列布局
    name: 'chat-workbench-mobile-drawer',
    path: '/?__smoke=participants&__tab=child-1',
    width: 390,
    height: 844,
    actions: [
      { type: 'expectVisible', selector: '.rw-thread' },
      { type: 'expectExpression',
        script: "const card = document.querySelector('.run-workbench__card'); if (!card) return false; const rect = card.getBoundingClientRect(); return Math.abs(rect.right - window.innerWidth) <= 2 && rect.width > 200 && rect.width < window.innerWidth",
        detail: "const card = document.querySelector('.run-workbench__card'); const rect = card?.getBoundingClientRect(); return { right: rect?.right ?? null, width: rect?.width ?? null, viewportWidth: window.innerWidth };" },
    ],
  },
  {
    // 浅色主题同样纳入回归：主题 token 是两套，改动必须两边都看
    name: 'chat-fileref-light-desktop',
    path: '/?__smoke=fileref',
    width: 1440,
    height: 900,
    theme: 'light',
    actions: [
      { type: 'mockFileRefApi' },
      { type: 'expectText', selector: '.message-stream', text: 'file_ref 三种 presentation 的渲染矩阵' },
    ],
  },
  {
    name: 'start-page-light-desktop',
    path: '/?__smoke=empty',
    width: 1440,
    height: 900,
    theme: 'light',
    actions: [
      { type: 'mockSessionSidebarApi' },
      { type: 'expectVisible', selector: '.session-setup-panel' },
      { type: 'expectText', selector: '.sidebar', text: 'ragsystem' },
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
  ...[{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }].map(viewport => ({
    name: `attachment-lightbox-${viewport.name}`,
    path: '/?__smoke=empty',
    width: viewport.width,
    height: viewport.height,
    actions: [
      { type: 'pointerClick', selector: '[aria-label="添加图片或文件"]' },
      { type: 'selectImageFixtures', selector: '.ctx-drawer-body input[type="file"]' },
      { type: 'expectCount', selector: '.ctx-file-thumb-btn', count: 2 },
      { type: 'pointerClick', selector: '.ctx-file-thumb-btn' },
      { type: 'expectImagesDecoded', selector: '.image-lightbox' },
      { type: 'expectStyle', selector: '.image-lightbox', property: 'pointerEvents', value: 'auto' },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="放大"]' },
      { type: 'expectText', selector: '.image-lightbox__zoom', text: '120%' },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="缩小"]' },
      { type: 'expectText', selector: '.image-lightbox__zoom', text: '100%' },
      { type: 'wheel', selector: '.image-lightbox__image', deltaY: -100 },
      { type: 'expectText', selector: '.image-lightbox__zoom', text: '115%' },
      { type: 'wheel', selector: '.image-lightbox__image', deltaY: 100 },
      { type: 'expectText', selector: '.image-lightbox__zoom', text: '100%' },
      { type: 'drag', selector: '.image-lightbox__image', deltaX: 60, deltaY: 30 },
      { type: 'expectExpression', script: "return document.querySelector('.image-lightbox__image').style.transform.includes('translate(60px, 30px)');" },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="重置视图"]' },
      { type: 'expectExpression', script: "return document.querySelector('.image-lightbox__image').style.transform.includes('translate(0px, 0px)');" },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="放大"]' },
      { type: 'holdImageDecode' },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="下一张"]', holdMs: 180, expectStableBounds: true },
      { type: 'expectExpression', script: "const image = document.querySelector('.image-lightbox__image'); return image.src === window.__smokeImageDecode.previousSrc && image.naturalWidth > 1 && image.getAttribute('aria-busy') === 'true' && image.style.transform.includes('scale(1.2)');" },
      { type: 'releaseImageDecode' },
      { type: 'expectExpression', script: "const image = document.querySelector('.image-lightbox__image'); return image.src !== window.__smokeImageDecode.previousSrc && image.complete && image.naturalWidth > 1 && !window.__smokeImageDecode.blankSource;" },
      { type: 'expectText', selector: '.image-lightbox__zoom', text: '100%' },
      { type: 'expectText', selector: '.image-lightbox__title', text: '现场照片-下游.png' },
      { type: 'expectVisible', selector: '.image-lightbox' },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="上一张"]', holdMs: 180, expectStableBounds: true },
      { type: 'expectText', selector: '.image-lightbox__title', text: '现场照片-上游.png' },
      { type: 'key', key: 'ArrowRight' },
      { type: 'expectText', selector: '.image-lightbox__title', text: '现场照片-下游.png' },
      { type: 'key', key: 'ArrowLeft' },
      { type: 'expectText', selector: '.image-lightbox__title', text: '现场照片-上游.png' },
      { type: 'key', key: 'Escape' },
      { type: 'expectHidden', selector: '.image-lightbox' },
      { type: 'expectVisible', selector: '.ctx-drawer-body' },
      { type: 'expectExpression', script: "return document.activeElement?.classList.contains('ctx-file-thumb-btn');" },
      { type: 'pointerClick', selector: '.ctx-file-thumb-btn' },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="放大"]' },
      { type: 'pointerClick', selector: '.image-lightbox [aria-label="关闭预览"]' },
      { type: 'expectHidden', selector: '.image-lightbox' },
      { type: 'expectVisible', selector: '.ctx-drawer-body' },
      { type: 'pointerClick', selector: '.ctx-file-thumb-btn' },
      { type: 'expectText', selector: '.image-lightbox__zoom', text: '100%' },
    ],
  })),
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
      { type: 'click', selector: '[aria-label="展开运行工作台"]', waitMs: 250 },
      { type: 'expectVisible', selector: '.runtime-overview' },
      { type: 'expectText', selector: '.rw-agents', text: '智能体' },
      // 面板是三卡片里的第三列：卡顶与对话卡同高，不悬在窗口上沿之下
      { type: 'expectTop', selector: '.run-workbench__card', maxTop: 20 },
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
      { type: 'expectVisible', selector: '[aria-label="展开运行工作台"]' },
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
      { type: 'mockAgentStudioApi' },
      { type: 'expectText', selector: 'body', text: 'Agent 配置' },
      { type: 'expectText', selector: '.panel-form', text: '基础信息' },
    ],
  },
  { name: 'agent-config-narrow', path: '/agent-config', width: 768, height: 900 },
  {
    // /team-builder 已并入 /agent-studio（路由重定向），断言按合并后的页面来
    name: 'desktop-team-builder',
    path: '/team-builder',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockAgentStudioApi' },
      { type: 'expectText', selector: 'body', text: 'Agent 编排' },
      { type: 'expectText', selector: '.studio-nav__title', text: 'Team / Agent' },
    ],
  },
  { name: 'team-builder-mobile', path: '/team-builder', width: 390, height: 844 },
  {
    name: 'desktop-knowledge-base',
    path: '/knowledge-base',
    width: 1440,
    height: 900,
    actions: [
      { type: 'mockKnowledgeBaseApi' },
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
      // 分区导航已改为统一分段控件（SegmentedControl）：搜索测试是第 5 项；
      // 指示器是 span，按 button 序数取。
      { type: 'click', selector: '[aria-label="知识库分区"] > button:nth-of-type(5)', waitMs: 500 },
      { type: 'expectText', selector: 'body', text: '检索工作台' },
      { type: 'expectVisible', selector: 'input[aria-label="搜索查询"]' },
    ],
  },
  { name: 'model-providers-narrow', path: '/model-providers', width: 768, height: 900 },
  {
    name: 'model-providers-test-menu',
    skip: 'Provider 页已工作台化：行操作测试菜单改为行内「测试模型」，断言待重写',
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
    skip: 'Provider 创建已改为工作台内联表单（ProviderFormDialog 不再引用），断言待重写',
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
    skip: 'Provider 编辑已改为工作台内联表单，model-map-editor 形态不再存在，断言待重写',
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
    skip: 'Provider 删除入口已改为详情面板「删除供应商」，断言待重写',
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
      // 分区导航已改为统一分段控件（SegmentedControl）：搜索测试是第 5 项；
      // 指示器是 span，按 button 序数取。
      { type: 'click', selector: '[aria-label="知识库分区"] > button:nth-of-type(5)', waitMs: 500 },
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
      // 分区导航已改为统一分段控件（SegmentedControl）：搜索测试是第 5 项；
      // 指示器是 span，按 button 序数取。
      { type: 'click', selector: '[aria-label="知识库分区"] > button:nth-of-type(5)', waitMs: 500 },
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
      // 分区导航已改为统一分段控件（SegmentedControl）：搜索测试是第 5 项；
      // 指示器是 span，按 button 序数取。
      { type: 'click', selector: '[aria-label="知识库分区"] > button:nth-of-type(5)', waitMs: 500 },
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
      // 同上：重排序器是第 4 项。
      { type: 'click', selector: '[aria-label="知识库分区"] > button:nth-of-type(4)', waitMs: 500 },
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
      // 同上：重排序器是第 4 项。
      { type: 'click', selector: '[aria-label="知识库分区"] > button:nth-of-type(4)', waitMs: 500 },
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
      { type: 'mockMcpApi' },
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
    skip: 'daemon 路由与「守护 Agent」页面已移除，待随新形态重写',
    actions: [
      { type: 'expectText', selector: 'body', text: '守护 Agent' },
      { type: 'expectText', selector: 'body', text: '基础配置' },
    ],
  },
  { name: 'daemon-narrow', path: '/daemon', width: 768, height: 900, skip: 'daemon 路由与「守护 Agent」页面已移除，待随新形态重写' },
  { name: 'system-config-mobile', path: '/system-config', width: 390, height: 844 },
  {
    name: 'agent-config-mobile-menu',
    skip: 'AgentStudio 未提供 #mobile-menu 插槽，「更多操作」按钮不渲染，断言待重写',
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
      { type: 'scrollToBottom', selector: '.workspace-body' },
      // 配置表单由多个 .panel-form 外壳组成，「委派」是其中最后一个；原来的
      // #section-delegation 锚点已不存在，改用「最后一个外壳在视口内」表达同一意图。
      { type: 'expectText', selector: '.panel-form:last-of-type', text: '委派' },
      { type: 'expectVisible', selector: '.panel-form:last-of-type' },
    ],
  },
  {
    name: 'daemon-mobile-menu',
    skip: 'daemon 路由与「守护 Agent」页面已移除，待随新形态重写',
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
      { type: 'expectText', selector: '.page-mobile-menu__list', text: '添加供应商' },
    ],
  },
  {
    name: 'model-providers-mobile-dialog',
    skip: 'Provider 创建已改为工作台内联表单（无「基础配置」对话框），断言待重写',
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

// —— 管理页演示数据（README 截图用）——
// 全部为虚构内容：不得混入真实 provider、真实文件名、真实 MCP 服务或任何密钥，
// 让管理页截图不依赖也不暴露本机运行时数据。
const demoAgentTier = (modelName) => ({
  provider: 'demo-openai',
  provider_type: 'openai',
  model_name: modelName,
  temperature: 0.7,
  max_completion_tokens: 32768,
  max_context_tokens: 131072,
  thinking_level: null,
  extra_params: {},
});

const DEMO_AGENT_CONFIGS = {
  orchestrator_agent: {
    agent_name: 'orchestrator_agent',
    display_name: 'Orchestrator',
    description: '主编排智能体：理解需求、拆解任务、委派协作并整合最终结果。',
    enabled: true,
    default_entry: true,
    llm_tiers: { default: demoAgentTier('demo-chat-64k') },
    tools: { enabled_tools: ['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'execute_code', 'web_fetch'] },
    goals: { enabled: true },
    tasks: { background: true },
    delegation: { enabled_agents: ['analysis_agent', 'report_agent', 'review_agent'], parallel_children: true },
    custom_params: {},
  },
  analysis_agent: {
    agent_name: 'analysis_agent',
    display_name: '水位分析',
    description: '读取监测数据、计算水位与流量指标，输出趋势结论。',
    enabled: true,
    default_entry: false,
    llm_tiers: { default: demoAgentTier('demo-chat-32k') },
    tools: { enabled_tools: ['read_file', 'preview_data_structure', 'execute_code'] },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: [], parallel_children: false },
    custom_params: {},
  },
  report_agent: {
    agent_name: 'report_agent',
    display_name: '报告撰写',
    description: '把分析结论整理成结构化报告，并按模板生成可视化图表。',
    enabled: true,
    default_entry: false,
    llm_tiers: { default: demoAgentTier('demo-chat-32k') },
    tools: { enabled_tools: ['read_file', 'write_file'] },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: [], parallel_children: false },
    custom_params: {},
  },
  review_agent: {
    agent_name: 'review_agent',
    display_name: '审校',
    description: '复核报告的事实一致性与格式规范，提出修订建议。',
    enabled: true,
    default_entry: false,
    llm_tiers: { default: demoAgentTier('demo-chat-32k') },
    tools: { enabled_tools: ['read_file'] },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: [], parallel_children: false },
    custom_params: {},
  },
};

const DEMO_AGENT_TEAMS = {
  active_team: 'water-quality',
  teams: [
    {
      team_name: 'water-quality',
      team_revision: 'demo000000000000000000000000000000000000000000000000000000001',
      file_path: 'teams/water-quality.yaml',
      agents: ['orchestrator_agent', 'analysis_agent', 'report_agent', 'review_agent'],
    },
    {
      team_name: 'doc-assist',
      team_revision: 'demo000000000000000000000000000000000000000000000000000000002',
      file_path: 'teams/doc-assist.yaml',
      agents: ['orchestrator_agent', 'analysis_agent'],
    },
  ],
};

const DEMO_MODEL_PROVIDERS = [
  { key: 'demo-openai', name: 'Demo OpenAI', provider_type: 'openai' },
  { key: 'demo-local', name: 'Demo Local vLLM', provider_type: 'openai-compatible' },
];

const DEMO_KB_UPLOADS = [
  { original_name: '供水管网巡检手册.pdf', size: 3355443, mime: 'application/pdf', uploaded_at: '2026-09-18T02:31:04.000Z', chunk_count: 24 },
  { original_name: '水质监测周报-0921.md', size: 49152, mime: 'text/markdown', uploaded_at: '2026-09-21T06:12:40.000Z', chunk_count: 16 },
  { original_name: '站点基础台账.json', size: 12288, mime: 'application/json', uploaded_at: '2026-09-22T09:05:18.000Z', chunk_count: 8 },
  { original_name: '应急响应预案.docx', size: 1153434, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', uploaded_at: '2026-09-25T11:47:52.000Z', chunk_count: 9 },
];

const DEMO_KB_FILES = DEMO_KB_UPLOADS.map((file, index) => ({
  id: `demo0${index + 1}a2b3c`,
  original_name: file.original_name,
  stored_name: `demo_stored_${index + 1}`,
  stored_path: `demo://knowledge-uploads/demo_stored_${index + 1}`,
  size: file.size,
  mime: file.mime,
  uploaded_at: file.uploaded_at,
  md_blob_hash: `demo_md_hash_${index + 1}`,
}));

const DEMO_KB_STATUS = {
  files: DEMO_KB_UPLOADS.map((file, index) => ({
    file_name: file.original_name,
    file_id: `demo0${index + 1}a2b3c`,
    collection: 'documents',
    chunk_count: file.chunk_count,
    vectorizer_status: file.chunk_count > 0 ? { 'demo-embedding': 'ready' } : {},
    uploaded_at: file.uploaded_at,
    size: file.size,
    mime: file.mime,
  })),
  vectorizers: [{ vectorizer_key: 'demo-embedding', is_active: true, model_name: 'demo-embedding-small' }],
};

const DEMO_VECTORIZERS = [
  {
    vectorizer_key: 'demo-embedding',
    provider_key: 'demo-openai',
    provider_type: 'openai',
    model_name: 'demo-embedding-small',
    api_endpoint: '',
    created_at: '2026-09-01T08:00:00.000Z',
    is_active: true,
    api_key_set: true,
    provider_managed: false,
    provider_available: true,
  },
];

const DEMO_RERANKERS = [
  {
    reranker_key: 'demo-reranker',
    mode: 'model',
    provider_key: 'demo-openai',
    provider_type: 'openai',
    model_name: 'demo-reranker-v2',
    api_endpoint: '',
    created_at: '2026-09-02T08:00:00.000Z',
    is_active: true,
    api_key_set: true,
    provider_managed: false,
    provider_available: true,
  },
];

const DEMO_MCP_SERVERS = [
  {
    name: 'demo_web_search',
    display_name: 'demo-web-search',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'demo-web-search@1.2.0'],
    env: {},
    url: null,
    headers: {},
    enabled: true,
    auto_connect: true,
    timeout: 30,
    risk_level: 'low',
    tool_risk_overrides: {},
    trusted: true,
    created_at: '2026-09-10T08:00:00.000Z',
    status: 'connected',
    tool_count: 6,
    error_message: '',
    resource_count: 2,
    prompt_count: 0,
    capability_faces: { tools: true, resources: true, prompts: false, logging: false },
    server_name: 'demo_web_search',
  },
  {
    name: 'demo_file_docs',
    display_name: 'demo-file-docs',
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: 'https://mcp.demo.example.com/file-docs',
    headers: {},
    enabled: true,
    auto_connect: false,
    timeout: 30,
    risk_level: 'medium',
    tool_risk_overrides: {},
    trusted: false,
    created_at: '2026-09-12T08:00:00.000Z',
    status: 'disconnected',
    tool_count: 0,
    error_message: '',
    resource_count: 0,
    prompt_count: 0,
    capability_faces: { tools: true, resources: false, prompts: false, logging: false },
    server_name: 'demo_file_docs',
  },
];

function demoAgentConfigBody(path) {
  if (path === '/api/agent-config/teams') {
    return { success: true, message: 'team 列表', data: DEMO_AGENT_TEAMS };
  }
  if (path === '/api/agent-config/configs') {
    return { success: true, message: 'ok', data: DEMO_AGENT_CONFIGS };
  }
  const singleMatch = path.match(/^\/api\/agent-config\/configs\/([^/]+)$/);
  if (singleMatch) {
    const config = DEMO_AGENT_CONFIGS[decodeURIComponent(singleMatch[1])] || DEMO_AGENT_CONFIGS.orchestrator_agent;
    return { success: true, message: 'ok', data: config };
  }
  if (path === '/api/agent-config/tools' || path === '/api/agent-config/mcp-servers') {
    return { success: true, message: 'ok', data: [] };
  }
  if (path === '/api/model-adapter/providers') {
    return { success: true, message: 'ok', providers: DEMO_MODEL_PROVIDERS };
  }
  if (path === '/api/skills/available') {
    return { success: true, message: 'ok', data: [] };
  }
  if (path === '/api/memory/config-metadata') {
    return { success: true, message: 'ok', data: {} };
  }
  if (/^\/api\/(skills|memory|knowledge-bases)\/agents\/[^/]+\/config$/.test(path)) {
    return { success: true, message: 'ok', data: {} };
  }
  return undefined;
}

function demoKnowledgeBaseBody(path) {
  if (path === '/api/knowledge-bases/files') {
    return { success: true, files: DEMO_KB_FILES };
  }
  if (path === '/api/knowledge-bases/file-status') {
    return { success: true, message: 'success', data: DEMO_KB_STATUS };
  }
  if (path === '/api/knowledge-bases/vectorizers') {
    return { success: true, message: 'success', data: DEMO_VECTORIZERS };
  }
  if (path === '/api/knowledge-bases/rerankers') {
    return { success: true, message: 'success', data: DEMO_RERANKERS };
  }
  if (path.startsWith('/api/knowledge-bases/model-providers')) {
    return { success: true, message: 'success', data: DEMO_MODEL_PROVIDERS };
  }
  if (/^\/api\/knowledge-bases\/agents\/[^/]+\/config$/.test(path)) {
    return { success: true, message: 'ok', data: {} };
  }
  return undefined;
}

function demoMcpBody(path) {
  if (path === '/api/mcp/servers') {
    return { success: true, message: 'success', data: DEMO_MCP_SERVERS };
  }
  if (path.startsWith('/api/mcp/registry/servers')) {
    return { success: true, message: 'ok', data: [] };
  }
  return undefined;
}

async function setupShotMocks(client, shot) {
  const mockArtifactApi = (shot.actions || []).some(action => action.type === 'mockArtifactApi');
  const mockKnowledgeSearchApi = (shot.actions || []).some(action => action.type === 'mockKnowledgeSearchApi');
  const mockSessionSidebarApi = (shot.actions || []).some(action => action.type === 'mockSessionSidebarApi');
  const mockFileRefApi = (shot.actions || []).some(action => action.type === 'mockFileRefApi');
  const mockAgentStudioApi = (shot.actions || []).some(action => action.type === 'mockAgentStudioApi');
  const mockKnowledgeBaseApi = (shot.actions || []).some(action => action.type === 'mockKnowledgeBaseApi');
  const mockMcpApi = (shot.actions || []).some(action => action.type === 'mockMcpApi');
  if (
    !mockArtifactApi && !mockKnowledgeSearchApi && !mockSessionSidebarApi && !mockFileRefApi
    && !mockAgentStudioApi && !mockKnowledgeBaseApi && !mockMcpApi
  ) return;

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
      ...(mockAgentStudioApi ? [
        { urlPattern: '*://*/api/agent-config/*', requestStage: 'Request' },
        { urlPattern: '*://*/api/model-adapter/providers*', requestStage: 'Request' },
        { urlPattern: '*://*/api/skills/*', requestStage: 'Request' },
        { urlPattern: '*://*/api/memory/*', requestStage: 'Request' },
        { urlPattern: '*://*/api/knowledge-bases/agents/*', requestStage: 'Request' },
      ] : []),
      ...(mockKnowledgeBaseApi ? [
        { urlPattern: '*://*/api/knowledge-bases/*', requestStage: 'Request' },
      ] : []),
      ...(mockMcpApi ? [
        { urlPattern: '*://*/api/mcp/*', requestStage: 'Request' },
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

    // 管理页演示数据：按 pathname 命中则直接应答，未命中放行到真实请求
    let demoPath = '';
    try {
      demoPath = new URL(event.request.url).pathname;
    } catch {
      demoPath = '';
    }
    let demoBody;
    if (mockAgentStudioApi) demoBody = demoAgentConfigBody(demoPath);
    if (!demoBody && mockKnowledgeBaseApi) demoBody = demoKnowledgeBaseBody(demoPath);
    if (!demoBody && mockMcpApi) demoBody = demoMcpBody(demoPath);
    if (demoBody) {
      await client.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(JSON.stringify(demoBody), 'utf8').toString('base64') });
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
    if (action.type === 'holdImageDecode') {
      await evaluate(client, `(() => {
        const image = document.querySelector('.image-lightbox__image');
        const original = Image.prototype.decode;
        const state = window.__smokeImageDecode = { previousSrc: image.src, blankSource: false };
        state.observer = new MutationObserver(() => {
          if (!image.getAttribute('src') || image.src.startsWith('data:image/gif')) state.blankSource = true;
        });
        state.observer.observe(image, { attributes: true, attributeFilter: ['src'] });
        Image.prototype.decode = function () {
          return original.call(this).then(() => new Promise(resolve => { state.release = resolve; }));
        };
        state.restore = () => { Image.prototype.decode = original; };
      })()`);
      continue;
    }

    if (action.type === 'releaseImageDecode') {
      if (!await waitForEvaluation(client, '!!window.__smokeImageDecode?.release', 5000)) {
        throw new Error(`${shot.name} did not stage the next image for decoding`);
      }
      await evaluate(client, `(() => {
        const state = window.__smokeImageDecode;
        state.restore();
        state.release();
      })()`);
      await wait(300);
      await evaluate(client, 'window.__smokeImageDecode.observer.disconnect()');
      continue;
    }

    if (action.type === 'selectImageFixtures') {
      const selected = await evaluate(client, `(async () => {
        const input = document.querySelector(${jsString(action.selector)});
        if (!input) return false;
        const { createSmokePendingImageAttachments } = await import('/src/utils/smokeFixtures.js');
        const transfer = new DataTransfer();
        for (const attachment of await createSmokePendingImageAttachments()) transfer.items.add(attachment.file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!selected) throw new Error(`${shot.name} could not find file input: ${action.selector}`);
      await wait(250);
      continue;
    }

    if (action.type === 'key') {
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: action.key, code: action.key });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: action.key, code: action.key });
      await wait(300);
      continue;
    }

    // 原生输入参与浏览器命中测试，避免 element.click() 绕过弹层的 pointer-events 禁用。
    if (['pointerClick', 'wheel', 'drag'].includes(action.type)) {
      await waitForEvaluation(client, `!!document.querySelector(${jsString(action.selector)})`, 5000);
      const point = await evaluate(client, `(() => {
        const rect = document.querySelector(${jsString(action.selector)})?.getBoundingClientRect();
        return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height } : null;
      })()`);
      if (!point) throw new Error(`${shot.name} could not find input selector: ${action.selector}`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      if (action.type === 'wheel') {
        await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: action.deltaY });
      } else {
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        if (action.holdMs) await wait(action.holdMs);
        if (action.expectStableBounds) {
          const pressed = await evaluate(client, `(() => {
            const rect = document.querySelector(${jsString(action.selector)}).getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
          })()`);
          if (['x', 'y', 'width', 'height'].some(key => Math.abs(point[key] - pressed[key]) > 0.5)) {
            throw new Error(`${shot.name} pressed button moved: ${action.selector}; before=${JSON.stringify(point)}, pressed=${JSON.stringify(pressed)}`);
          }
        }
        const end = action.type === 'drag' ? { x: point.x + action.deltaX, y: point.y + action.deltaY } : point;
        if (action.type === 'drag') await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...end, button: 'left', buttons: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', clickCount: 1 });
      }
      await wait(300);
      continue;
    }

    if (action.type === 'mockArtifactApi' || action.type === 'mockKnowledgeSearchApi' || action.type === 'mockSessionSidebarApi' || action.type === 'mockFileRefApi'
      || action.type === 'mockAgentStudioApi' || action.type === 'mockKnowledgeBaseApi' || action.type === 'mockMcpApi') {
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
        // 失败时把实际值一并抛出：断言写错值时空看元素个数会误判成「没渲染」
        const detail = action.type === 'expectCount'
          ? await evaluate(client, `document.querySelectorAll(${jsString(action.selector)}).length`)
          : await evaluate(client, `(() => { const element = document.querySelector(${jsString(action.selector)}); return element ? getComputedStyle(element)[${jsString(action.property)}] : '(元素不存在)'; })()`);
        throw new Error(`${shot.name} failed ${action.type} for ${action.selector}: 实际 ${JSON.stringify(detail)}，期望 ${JSON.stringify(action.value ?? action.count)}`);
      }
      continue;
    }

    if (action.type === 'expectExpression') {
      // 任意表达式的断言口子：滚动位置、几何关系这类没法用单条 computed style 描述的契约。
      // script / detail 都是一段语句体（自己 return），不是单个表达式。
      const passed = await waitForEvaluation(client, `(() => { ${action.script} })()`, action.timeoutMs ?? 5000);
      if (!passed) {
        const detail = action.detail ? await evaluate(client, `(() => { ${action.detail} })()`) : null;
        throw new Error(`${shot.name} failed expectExpression: ${action.script}${detail === null ? '' : ` （实际 ${JSON.stringify(detail)}）`}`);
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
      // 等元素出现再点：单次 querySelector 会在挂载前落空，让场景变成偶发失败。
      // 表达式只在元素存在时点击并返回 true，因此不会重复点击。
      const clicked = await waitForEvaluation(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        element.click();
        return true;
      })()`, 5000);
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

    if (action.type === 'scrollToBottom' || action.type === 'scrollToTop') {
      const toTop = action.type === 'scrollToTop';
      const scrolled = await evaluate(client, `(() => {
        const element = document.querySelector(${jsString(action.selector)});
        if (!element) return false;
        element.scrollTop = ${toTop ? 0 : 'element.scrollHeight'};
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
    // 主题由 localStorage 单源驱动（stores/theme.js），在文档创建前种下即可切浅色
    if (shot.theme === 'light') {
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: "localStorage.setItem('theme', 'light');",
      });
    }
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
      // 场景可带 skip: '<原因>' 标注：界面形态已变、断言待重写时用，
      // 显式跳过而不是留红（原因会打出来，别让它悄悄烂掉）。
      if (shot.skip) {
        console.log(`${shot.name}: skipped — ${shot.skip}`);
        continue;
      }
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
