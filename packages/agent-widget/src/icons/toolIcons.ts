// widget 工具图标库：lucide 风格（24x24 / stroke=currentColor / 圆角端点），
// 集中管理所有工具行前置图标。零依赖、Shadow DOM 友好（v-html 注入后 :deep(svg) 控尺寸）。
// 颜色不在此固定，由调用方 CSS 控制（默认跟随工具名色，hover/运行/失败随状态变化）。

const S = (inner: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

// ── 图标集（26 个，覆盖后端工具 + 前端通用工具 + 子智能体/委托类）──
export const TOOL_ICONS: Record<string, string> = {
  book:       S('<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>'),
  database:   S('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>'),
  file:       S('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  code:       S('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
  terminal:   S('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
  globe:      S('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>'),
  cpu:        S('<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>'),
  image:      S('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>'),
  camera:     S('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  cloud:      S('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'),
  clock:      S('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  calendar:   S('<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>'),
  mail:       S('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  map:        S('<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>'),
  link:       S('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  clipboard:  S('<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>'),
  bell:       S('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  bot:        S('<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'),
  sparkles:   S('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>'),
  list:       S('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
  send:       S('<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>'),
  shield:     S('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
  help:       S('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  calculator: S('<rect x="4" y="2" width="16" height="20" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>'),
  search:     S('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  lightbulb:  S('<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>'),
  wrench:     S('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
};

// ── 工具名 → 图标映射（顺序敏感：具体关键词在前，通用词在后，先命中先返回）──
const TOOL_ICON_RULES: { icon: string; keys: string[] }[] = [
  { icon: 'book',       keys: ['kb', 'knowledge', 'retriev', 'rag', 'doc_search'] },
  { icon: 'database',   keys: ['vector', 'database', 'sql', 'postgres', 'index_', 'db_'] },
  { icon: 'file',       keys: ['file', 'read_', 'fs_', 'open_doc'] },
  { icon: 'code',       keys: ['code', 'python', 'eval', 'run_', 'execute'] },
  { icon: 'terminal',   keys: ['terminal', 'shell', 'bash', 'command'] },
  { icon: 'globe',      keys: ['web_search', 'browse', 'fetch', 'http', 'request', 'craw', 'curl'] },
  { icon: 'cpu',        keys: ['memory', 'mem_', 'save_', 'store', 'remember'] },
  { icon: 'image',      keys: ['image', 'vision', 'ocr', 'picture', 'photo'] },
  { icon: 'camera',     keys: ['screenshot', 'capture', 'snapshot'] },
  { icon: 'cloud',      keys: ['weather', 'climate'] },
  { icon: 'clock',      keys: ['time', 'now', 'timestamp'] },
  { icon: 'calendar',   keys: ['calendar', 'date', 'schedule', 'event'] },
  { icon: 'mail',       keys: ['mail', 'email', 'smtp'] },
  { icon: 'map',        keys: ['location', 'geo', 'map_', 'place'] },
  { icon: 'link',       keys: ['page', 'title', 'link', 'url'] },
  { icon: 'clipboard',  keys: ['clipboard', 'copy', 'paste'] },
  { icon: 'bell',       keys: ['notif', 'alert', 'remind'] },
  { icon: 'bot',        keys: ['agent', 'delegate', 'subagent'] },
  { icon: 'sparkles',   keys: ['skill', 'activate'] },
  { icon: 'list',       keys: ['task', 'plan', 'todo', 'route'] },
  { icon: 'send',       keys: ['send', 'message', 'reply'] },
  { icon: 'shield',     keys: ['approv', 'permit', 'gate'] },
  { icon: 'help',       keys: ['ask', 'input', 'question', 'clarif'] },
  { icon: 'calculator', keys: ['calc', 'math', 'compute'] },
  { icon: 'search',     keys: ['search', 'query', 'find', 'lookup'] },
];

// 工具名归一化后按规则顺序匹配；命中即返回对应图标，否则返回 fallback（默认 wrench）。
// fallbackKey 用于语义固定的节点：子智能体本质也是工具调用，按名未中时用 'bot' 兜底。
export function getToolIcon(toolName: string, fallbackKey: string = 'wrench'): string {
  const n = String(toolName || '').toLowerCase();
  for (const r of TOOL_ICON_RULES) {
    if (r.keys.some((k) => n.includes(k))) return TOOL_ICONS[r.icon]!;
  }
  return TOOL_ICONS[fallbackKey] ?? TOOL_ICONS.wrench!;
}
