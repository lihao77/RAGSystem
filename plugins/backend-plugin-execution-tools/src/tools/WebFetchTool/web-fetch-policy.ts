/**
 * web_fetch 的 URL 校验与内容类型分类——纯函数、无网络（对齐 deepseek-harness
 * web-fetch-http/policy.ts）。传输侧（重定向跟随、字节上限、解码）由
 * web-fetch-client.ts 组合这些策略。
 */

export type WebFetchErrorCode =
  | "invalid_url"
  | "blocked_url"
  | "redirect_blocked"
  | "unsupported_content_type"
  | "too_large"
  | "timeout"
  | "aborted"
  | "provider_error";

/** 带稳定错误码的 web_fetch 失败；工具层据此给出明确的模型可见消息。 */
export class WebFetchError extends Error {
  constructor(message: string, readonly code: WebFetchErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebFetchError";
  }
}

/** 公开抓取接受的请求 URL 长度上限。 */
export const WEB_FETCH_MAX_URL_LENGTH = 2048;

/** 可解码的 body 类别：html 走 markdown 转换，text 原样透传。 */
export type FetchableKind = "html" | "text";

/**
 * 解析请求 URL 并施加与网络无关的传输限制：仅 http(s)、URL 内嵌凭据拒绝。
 * 公网地址解析与连接钉扎在此之后进行。
 */
export function parseFetchUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error: unknown) {
    throw new WebFetchError(`无效 URL: ${input}`, "invalid_url", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(`不支持的 URL scheme "${url.protocol}"（仅允许 http/https）`, "invalid_url");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebFetchError("URL 内嵌凭据不被允许", "blocked_url");
  }
  return url;
}

/** 完整的请求前校验：长度上限 + parseFetchUrl 的全部限制。 */
export function validateFetchUrl(input: string): URL {
  if (input.length > WEB_FETCH_MAX_URL_LENGTH) {
    throw new WebFetchError(`URL 超过最大长度 ${WEB_FETCH_MAX_URL_LENGTH}`, "invalid_url");
  }
  return parseFetchUrl(input);
}

/**
 * 同源 = scheme/hostname/port 全一致。跨源重定向拒绝自动跟随——每个新 origin
 * 都必须由模型发起一次新的工具调用，重新走公网地址校验。
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

/**
 * 把响应 Content-Type 分类为可解码类别；text/html 与 application/xhtml+xml 归
 * html，其余 text/* 与结构化文本（json/xml 及 +json/+xml 后缀）归 text，
 * 二进制等不支持类型返回 undefined。
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? "").replace(/;.*$/s, "").trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  return undefined;
}

/** 提取 Content-Type 的 charset 参数（小写）；缺省 undefined。 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? "");
  return match?.[1]?.trim().toLowerCase();
}

/**
 * 按声明的 charset 构建 TextDecoder（缺省 UTF-8）。标签不被 TextDecoder 认识
 * 时显式报错——宁可失败也不返回乱码。
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder("utf-8");
  try {
    return new TextDecoder(charset);
  } catch (error: unknown) {
    throw new WebFetchError(`不支持的字符集 "${charset}"`, "unsupported_content_type", { cause: error });
  }
}
