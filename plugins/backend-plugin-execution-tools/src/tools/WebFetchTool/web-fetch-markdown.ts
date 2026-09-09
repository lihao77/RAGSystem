/**
 * HTML→Markdown 转换（对齐 deepseek-harness tool-web/fetch.ts 的转换层）：
 * turndown（内置 domino DOM）+ GFM 表格/删除线插件，配两条自研规则——
 * 非可见内容整体删除（script/style/hidden/display:none 等，turndown 默认会
 * 保留其文本）、表格单元格忽略 colspan 展开（转换工作量与源码成正比，而非
 * 与数字属性成正比——防恶意 colspan 放大）。
 *
 * 转换同步跑在事件循环上（超时定时器期间无法触发），故先做一次词法深度
 * 扫描：未闭合标签的嵌套会让 domino 树与 turndown 遍历超线性（实测 depth
 * 512≈0.15s、2000≈2s、20000≈5s），超过 512 层直接省略内容而非转换。
 */
import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
turndown.addRule("removeNonVisibleContent", {
  filter(node) {
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED"].includes(node.nodeName)) return true;
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden")?.toLowerCase() === "true") return true;
    if (node.nodeName === "INPUT" && node.getAttribute("type")?.toLowerCase() === "hidden") return true;
    const declarations = node.getAttribute("style")?.split(";") ?? [];
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator === -1) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, "");
      return (property === "display" && value === "none")
        || (property === "visibility" && (value === "hidden" || value === "collapse"));
    });
  },
  replacement() {
    return "";
  },
});

/** 渲染一个 GFM 表格单元格，不解释 HTML 的跨列数。 */
function renderTableCell(content: string, index: number): string {
  const prefix = index === 0 ? "| " : " ";
  const escaped = content.trim().replace(/\n\r/g, "<br>").replace(/\n/g, "<br>").replace(/\|+/g, "\\|").padEnd(3, " ");
  return `${prefix}${escaped} |`;
}

/** 该行是否为表格的 Markdown 标题行。 */
function isTableHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells);
  const section = row.parentElement as HTMLTableSectionElement;
  const table = section.parentElement as HTMLTableElement;
  return (section.nodeName === "THEAD" || table.rows[0] === row)
    && cells.every((cell) => cell.nodeName === "TH");
}

/** HTML 单元格对齐方式 → GFM 分隔标记。 */
function tableBorder(cell: HTMLTableCellElement): string {
  const alignment = (cell.getAttribute("align") || cell.style.textAlign || "").toLowerCase();
  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";
  return "---";
}

turndown.addRule("tableCellWithoutSpanExpansion", {
  filter: ["th", "td"],
  replacement(content, node) {
    const cell = node as HTMLTableCellElement;
    const row = cell.parentNode as HTMLTableRowElement;
    // GFM 无法表达跨列单元格；忽略 colspan 让转换与输出和源码成正比。
    return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell));
  },
});
turndown.addRule("tableRowWithoutSpanExpansion", {
  filter: "tr",
  replacement(content, node) {
    const row = node as HTMLTableRowElement;
    const border = isTableHeadingRow(row)
      ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join("")
      : "";
    return `\n${content}${border.length > 0 ? `\n${border}` : ""}`;
  },
});

/** HTML 跳过转换、原样透传的嵌套深度上限（鲁棒性不变量，非可调参数）。 */
const MAX_CONVERSION_DEPTH = 512;

/** 无闭合标签的元素（不增长词法栈）。 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** 内容按纯文本解析直到匹配结束标签的元素。 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "noscript"]);

/** raw-text 结束标签名之后允许出现的字符。 */
function isTagBoundary(char: string | undefined): boolean {
  return char === undefined || char === ">" || char === "/" || /\s/.test(char);
}

/** 不解释正文体中的类标记文本，找到 raw-text 元素的匹配结束标签。 */
function findRawTextEnd(lowerHtml: string, name: string, from: number): number {
  const prefix = `</${name}`;
  let candidate = lowerHtml.indexOf(prefix, from);
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length);
  }
  return candidate;
}

/**
 * 保守拒绝词法元素栈超过转换深度上限的 HTML。单遍扫描：忽略注释内的闭合
 * 标签、跳过 raw-text 体、尊重引号内的 `>`、只接受与当前元素匹配的闭合
 * 标签——畸形输入因此只会多计嵌套，不会隐藏嵌套。
 */
function exceedsConversionDepth(html: string): boolean {
  const lowerHtml = html.toLowerCase();
  const openElements: string[] = [];
  let offset = 0;
  let inComment = false;

  while (offset < html.length) {
    const start = html.indexOf("<", offset);
    if (inComment) {
      const end = html.indexOf("-->", offset);
      if (end !== -1 && (start === -1 || end < start)) {
        inComment = false;
        offset = end + 3;
        continue;
      }
    }
    if (start === -1) break;
    if (!inComment && html.startsWith("<!--", start)) {
      inComment = true;
      offset = start + 4;
      continue;
    }

    let cursor = start + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? "")) cursor += 1;
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1;
      continue;
    }

    const name = lowerHtml.slice(nameStart, cursor);
    let quote: '"' | "'" | undefined;
    while (cursor < html.length) {
      const char = html[cursor];
      cursor += 1;
      if (quote !== undefined) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (html[cursor - 1] !== ">") break;

    if (closing) {
      if (!inComment && openElements.at(-1) === name) openElements.pop();
    } else {
      let last = cursor - 2;
      while (/\s/.test(html.charAt(last))) last -= 1;
      if (!VOID_ELEMENTS.has(name) && html[last] !== "/") {
        openElements.push(name);
        if (openElements.length > MAX_CONVERSION_DEPTH) return true;
        if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor);
          if (end === -1) break;
          offset = end;
          continue;
        }
      }
    }
    offset = cursor;
  }
  return false;
}

/** 转换失败/过深时的固定省略标记——不让原始活动标记进入模型可见结果。 */
export const HTML_OMISSION_MARKER = "[HTML content omitted: unable to convert safely.]";

/** 把已解码的 HTML 转成 markdown；过深或转换抛错时返回省略标记。 */
export function htmlToMarkdown(html: string): string {
  if (exceedsConversionDepth(html)) return HTML_OMISSION_MARKER;
  try {
    return turndown.turndown(html);
  } catch {
    // turndown 的 DOM 遍历按元素递归；词法护栏覆盖不到的畸形标记仍可能抛
    // RangeError。转换失败不返回任何源标记。
    return HTML_OMISSION_MARKER;
  }
}

/** 渲染后的 body 与"转换前源是否被截"。 */
export interface RenderedBody {
  text: string;
  sourceTruncated: boolean;
}

/**
 * 把抓取到的 body 渲染为模型可见文本：html 经护栏转换，text 原样透传。
 * maxInputChars 限制同步处理的源字符数。
 */
export function renderBody(body: { kind: "html" | "text"; content: string }, maxInputChars: number): RenderedBody {
  const content = body.content.slice(0, maxInputChars);
  const sourceTruncated = content.length !== body.content.length;
  if (body.kind === "html") {
    return { text: htmlToMarkdown(content), sourceTruncated };
  }
  return { text: content, sourceTruncated };
}
