/**
 * 响应式断点（JS 侧唯一来源）。
 *
 * 侧栏切抽屉 / 页面顶栏换移动端导航 / 表单换单列，共用这一条宽度。
 * CSS 媒体查询读不到 JS 常量，样式表里必须写同样的字面量，共三处：
 *   - src/styles/chat-view.css  顶栏回到文档流、消息区顶部留白
 *   - src/styles/forms.css      表单换单列、参数面板加高
 *   - src/components/PageLayout.vue  页面顶栏隐藏、移动端导航显示
 * breakpoints.test.js 校验两边同值：改这里就要同步改这三处。
 *
 * 判定用 matchMedia 而不是 window.innerWidth —— 后者含滚动条宽度，
 * 会和 CSS 的判定基准差几个像素（在 900 附近出现「抽屉已出、布局仍按宽屏」）。
 */
export const SIDEBAR_OVERLAY_MAX_WIDTH = 900;

/** 与样式表 @media 里同一条查询。 */
export const SIDEBAR_OVERLAY_QUERY = `(max-width: ${SIDEBAR_OVERLAY_MAX_WIDTH}px)`;
