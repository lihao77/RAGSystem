/**
 * Markdown 渲染配置
 *
 * 使用 markdown-it + highlight.js 提供强大的 Markdown 渲染能力
 */

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'

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
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch (err) {
        console.error('Highlight error:', err)
      }
    }
    // 使用默认的转义
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`
  }
})

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
