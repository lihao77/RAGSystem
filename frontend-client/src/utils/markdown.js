/**
 * Markdown 渲染配置
 *
 * 使用 markdown-it + highlight.js 提供强大的 Markdown 渲染能力
 */

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeBlockContent(value) {
  return encodeURIComponent(String(value ?? ''))
}

function buildBlockHeader({ title, copyType, copyPayload }) {
  return `<div class="md-block-head"><span class="md-block-title">${title}</span><button class="md-block-copy-btn" type="button" data-copy-type="${copyType}" data-copy-content="${escapeAttr(copyPayload)}" aria-label="复制${title}"><span class="md-block-copy-btn__icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h5.5a2 2 0 0 1 2 2v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><span class="md-block-copy-btn__label">复制</span></button></div>`
}

function renderHighlightedCode(str, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
    } catch (err) {
      console.error('Highlight error:', err)
    }
  }
  return md.utils.escapeHtml(str)
}

function renderCodeBlock(str, lang) {
  const language = (lang || '').trim()
  const title = language || '代码'
  const highlighted = renderHighlightedCode(str, language)
  const header = buildBlockHeader({
    title,
    copyType: 'code',
    copyPayload: escapeBlockContent(str),
  })
  return `<div class="md-special-block md-code-block">${header}<div class="md-block-body"><pre class="hljs"><code>${highlighted}</code></pre></div></div>`
}

// 初始化 markdown-it
const md = new MarkdownIt({
  // 启用 HTML 标签
  html: true,

  // 自动将 URL 转换为链接
  linkify: true,

  // 启用排版优化（智能引号、破折号等）
  typographer: true,

  // 换行符转换为 <br>
  breaks: true,

  // 代码高亮
  highlight: function (str, lang) {
    return renderCodeBlock(str, lang)
  }
})

const defaultTableOpen = md.renderer.rules.table_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
const defaultTableClose = md.renderer.rules.table_close || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
const defaultBlockquoteOpen = md.renderer.rules.blockquote_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
const defaultBlockquoteClose = md.renderer.rules.blockquote_close || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
  env.__tableIndex = (env.__tableIndex || 0) + 1
  const tableId = `md-table-${env.__tableIndex}`
  if (!env.__tableStack) env.__tableStack = []
  env.__tableStack.push(tableId)
  const header = buildBlockHeader({
    title: '表格',
    copyType: 'table',
    copyPayload: tableId,
  })
  return `<div class="md-special-block md-table-block" data-table-id="${tableId}">${header}<div class="md-block-body md-table-scroll">${defaultTableOpen(tokens, idx, options, env, self)}`
}

md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
  if (env.__tableStack?.length) env.__tableStack.pop()
  return `${defaultTableClose(tokens, idx, options, env, self)}</div></div>`
}

md.renderer.rules.blockquote_open = function (tokens, idx, options, env, self) {
  env.__blockquoteIndex = (env.__blockquoteIndex || 0) + 1
  const quoteId = `md-quote-${env.__blockquoteIndex}`
  const header = buildBlockHeader({
    title: '引用',
    copyType: 'quote',
    copyPayload: quoteId,
  })
  return `<div class="md-special-block md-quote-block" data-quote-id="${quoteId}">${header}<div class="md-block-body">${defaultBlockquoteOpen(tokens, idx, options, env, self)}`
}

md.renderer.rules.blockquote_close = function (tokens, idx, options, env, self) {
  return `${defaultBlockquoteClose(tokens, idx, options, env, self)}</div></div>`
}

// 🔧 异步加载插件（避免 ESM 兼容性问题）
const loadPlugins = async () => {
  try {
    // 动态导入 emoji 插件
    const emojiModule = await import('markdown-it-emoji')
    const emoji = emojiModule.default || emojiModule

    if (typeof emoji === 'function') {
      md.use(emoji)
      console.log('✓ markdown-it-emoji loaded')
    }
  } catch (err) {
    console.warn('markdown-it-emoji not available:', err.message)
  }

  try {
    // 动态导入任务列表插件
    const taskListsModule = await import('markdown-it-task-lists')
    const taskLists = taskListsModule.default || taskListsModule

    if (typeof taskLists === 'function') {
      md.use(taskLists, { enabled: true })
      console.log('✓ markdown-it-task-lists loaded')
    }
  } catch (err) {
    console.warn('markdown-it-task-lists not available:', err.message)
  }
}

// 开始加载插件（不阻塞初始化）
loadPlugins().catch(err => {
  console.warn('Plugin loading failed:', err)
})

/**
 * 渲染 Markdown 文本为 HTML
 *
 * @param {string} text - Markdown 文本
 * @returns {string} - HTML 字符串
 */
export function renderMarkdown(text) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  try {
    return md.render(text)
  } catch (err) {
    console.error('Markdown render error:', err)
    return md.utils.escapeHtml(text)
  }
}

/**
 * 渲染单行 Markdown（不添加 <p> 标签）
 *
 * @param {string} text - Markdown 文本
 * @returns {string} - HTML 字符串
 */
export function renderMarkdownInline(text) {
  if (!text || typeof text !== 'string') {
    return ''
  }

  try {
    return md.renderInline(text)
  } catch (err) {
    console.error('Markdown render error:', err)
    return md.utils.escapeHtml(text)
  }
}

export default md
