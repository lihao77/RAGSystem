/**
 * Markdown 渲染：markdown-it + highlight.js（20 语言代码高亮）+ emoji/task-lists。
 *
 * widget 极简：不包复制按钮 / 表格 / 引用特殊块（那套 UI 依赖配套 CSS 与点击监听，
 * widget 从未引入），回归 markdown-it 默认渲染——代码块由 highlight 回调高亮后
 * 交 markdown-it 包成 <pre><code>，表格/引用走默认。html:false 防 XSS。
 */
import MarkdownIt from "markdown-it";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { light as emoji } from "markdown-it-emoji";
import taskLists from "markdown-it-task-lists";

const highlightLanguages = {
  bash,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  markdown: markdownLang,
  php,
  powershell,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

Object.entries(highlightLanguages).forEach(([name, language]) => {
  hljs.registerLanguage(name, language);
});

hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["c++", "cc", "cxx", "hpp"], { languageName: "cpp" });
hljs.registerAliases(["cs"], { languageName: "csharp" });
hljs.registerAliases(["docker"], { languageName: "dockerfile" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["jsonc"], { languageName: "json" });
hljs.registerAliases(["md"], { languageName: "markdown" });
hljs.registerAliases(["ps1"], { languageName: "powershell" });
hljs.registerAliases(["py"], { languageName: "python" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["html", "svg", "vue"], { languageName: "xml" });
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
