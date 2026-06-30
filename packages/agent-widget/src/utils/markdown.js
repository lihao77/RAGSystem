/**
 * Markdown 渲染：markdown-it + highlight.js（7 语言代码高亮：js/ts/python/bash/json/sql/yaml）+ emoji/task-lists。
 *
 * widget 极简：不包复制按钮 / 表格 / 引用特殊块（那套 UI 依赖配套 CSS 与点击监听，
 * widget 从未引入），回归 markdown-it 默认渲染——代码块由 highlight 回调高亮后
 * 交 markdown-it 包成 <pre><code>，表格/引用走默认。html:false 防 XSS。
 * 仅注册常用语言以压缩 bundle；冷门语言回落纯文本（无着色）。
 */
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { light as emoji } from "markdown-it-emoji";
import taskLists from "markdown-it-task-lists";

const highlightLanguages = {
  bash,
  javascript,
  json,
  python,
  sql,
  typescript,
  yaml,
};

Object.entries(highlightLanguages).forEach(([name, language]) => {
  hljs.registerLanguage(name, language);
});

hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["jsonc"], { languageName: "json" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["yml"], { languageName: "yaml" });

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(str, lang) {
    const language = (lang || "").trim();
    if (language && hljs.getLanguage(language)) {
      try {
        return hljs.highlight(str, { language, ignoreIllegals: true }).value;
      } catch {
        // 高亮失败：回落到默认转义（返回空串由 markdown-it 处理）。
      }
    }
    return "";
  },
});

md.use(emoji);
md.use(taskLists, { enabled: true });

export function renderMarkdown(text) {
  if (!text || typeof text !== "string") {
    return "";
  }
  try {
    return md.render(text);
  } catch (err) {
    console.error("Markdown render error:", err);
    return md.utils.escapeHtml(text);
  }
}

export default md;
