import TurndownService from "turndown";

export function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({ codeBlockStyle: "fenced", headingStyle: "atx", bulletListMarker: "-" });
  turndown.remove(["script", "style", "noscript"]);
  return normalizeMarkdown(turndown.turndown(html));
}

export function markdownToText(markdown: string): string {
  return markdown.replace(/^#{1,6}\s+/gm, "").replace(/^```[^\n]*\n|^```$/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/^\s*\d+[.)]\s+/gm, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_~`]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
