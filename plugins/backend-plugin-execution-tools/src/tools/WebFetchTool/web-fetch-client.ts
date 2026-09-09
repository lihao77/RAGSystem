/**
 * web_fetch 的 HTTP(S) 客户端（对齐 deepseek-harness web-fetch-http/provider.ts，
 * 去除代理路由层）：公网校验 + 地址钉扎、仅同源重定向且有跳数上限、时间与字节/
 * 字符双层上限、按声明字符集解码。请求不携带浏览器 cookie 或任何宿主凭据。
 */
import type { Response } from "undici";
import { ProxyAgent, fetch } from "undici";
import {
  WebFetchError,
  classifyContentType,
  decoderForCharset,
  isSameOrigin,
  parseCharset,
  validateFetchUrl,
  type FetchableKind,
} from "./web-fetch-policy.js";
import {
  requestPinned,
  resolvePublicAddresses,
  type AddressResolver,
  type PublicAddress,
} from "./web-fetch-network.js";

/** 客户端限额（默认值对齐业界 harness 的 web fetch 配置）。 */
export interface WebFetchLimits {
  /** 响应 body 的字节上限（超过即中止读取）。 */
  maxResponseBytes: number;
  /** 解码后 body 的字符上限（超出截断）。 */
  maxBodyChars: number;
  /** 重定向跟随的跳数上限（仅同源）。 */
  maxRedirects: number;
  /** 每个请求的 User-Agent。 */
  userAgent: string;
}

export const DEFAULT_WEB_FETCH_LIMITS: WebFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 200_000,
  maxRedirects: 5,
  userAgent: "ragsystem-agent/0.1",
};

export interface WebFetchOutcome {
  /** 跟随（同源）重定向后的最终 URL。 */
  url: string;
  statusCode: number;
  contentType: string | null;
  body: { kind: FetchableKind; content: string };
  truncated: boolean;
}

export type { AddressResolver, PublicAddress };

/** 解析 hostname 到已过公网策略校验的地址集。 */
export type HttpFetchResolver = (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>;

export class WebFetchClient {
  constructor(
    private readonly limits: WebFetchLimits = DEFAULT_WEB_FETCH_LIMITS,
    private readonly resolveAddresses: HttpFetchResolver = (hostname, signal) => resolvePublicAddresses(hostname, signal),
  ) {}

  /**
   * 抓取一个 URL。timeoutMs 为本次请求的超时（与调用方 signal 取先到者）；
   * 请求与 body 读取由同一信号终止。
   */
  async fetch(
    url: string,
    options: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<WebFetchOutcome> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const onCallerAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onCallerAbort, { once: true });
    // 中止/超时按触发源分类（DNS 解析、连接、读流各阶段的失败都经此判定），
    // 与抛错现场无关——undici 在请求阶段与读流阶段抛出的错误形状不同。
    const abortErrorOf = (): WebFetchError | null => {
      if (timedOut) return new WebFetchError(`web fetch 超时（${options.timeoutMs}ms）`, "timeout");
      if (options.signal?.aborted) {
        return new WebFetchError("web fetch 已被中止（工具超时或调用方取消）", "aborted");
      }
      return null;
    };
    try {
      return await this.followAndRead(url, controller.signal, abortErrorOf);
    } catch (error: unknown) {
      if (error instanceof WebFetchError) throw error;
      const abort = abortErrorOf();
      if (abort !== null) {
        throw Object.assign(abort, { cause: error });
      }
      throw new WebFetchError(`web fetch 网络失败: ${errorMessage(error)}`, "provider_error", { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** 跟随同源重定向至上限，然后读取最终响应。 */
  private async followAndRead(
    initialUrl: string,
    signal: AbortSignal,
    abortErrorOf: () => WebFetchError | null,
  ): Promise<WebFetchOutcome> {
    let currentUrl = validateFetchUrl(initialUrl);
    let redirectsFollowed = 0;

    for (;;) {
      const request = await this.requestOnce(currentUrl, signal, abortErrorOf);
      const { response } = request;
      try {
        if (isRedirectStatus(response.status)) {
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel();
            throw new WebFetchError(`重定向超过上限 ${this.limits.maxRedirects} 跳`, "redirect_blocked");
          }
          const location = response.headers.get("location");
          if (location === null) {
            await response.body?.cancel();
            throw new WebFetchError(`重定向响应（HTTP ${response.status}）缺少 Location 头`, "provider_error");
          }
          const target = resolveRedirect(location, currentUrl);
          let validatedTarget: URL;
          try {
            validatedTarget = validateFetchUrl(target.toString());
            if (!isSameOrigin(validatedTarget, currentUrl)) {
              throw new WebFetchError(
                `跨源重定向到 ${validatedTarget.origin} 不会自动跟随；请对该 URL 直接重试`,
                "redirect_blocked",
              );
            }
          } catch (error: unknown) {
            await response.body?.cancel();
            throw error;
          }
          await response.body?.cancel();
          currentUrl = validatedTarget;
          redirectsFollowed++;
          continue;
        }

        return await this.readBody(response, currentUrl, abortErrorOf);
      } finally {
        await request.close();
      }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal, abortErrorOf: () => WebFetchError | null) {
    const headers = {
      "user-agent": this.limits.userAgent,
      "accept": "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8",
    };
    try {
      const proxyUrl = proxyUrlFor(url);
      if (proxyUrl !== null) {
        // 走代理的请求跳过公网解析与钉扎：源站由代理解析，本地钉扎反而会绕开代理
        // 直连（对齐 deepseek-harness web-fetch-http 的代理语义）。
        return await requestViaProxy(proxyUrl, url, headers, signal);
      }
      const addresses = await this.resolveAddresses(url.hostname, signal);
      return await requestPinned(url, addresses, headers, signal);
    } catch (error: unknown) {
      if (error instanceof WebFetchError) throw error;
      { const abort = abortErrorOf(); if (abort !== null) throw Object.assign(abort, { cause: error }); }
      throw new WebFetchError(`web fetch 网络失败: ${errorMessage(error)}`, "provider_error", { cause: error });
    }
  }

  /** 读取、字节封顶、分类并解码最终响应 body。 */
  private async readBody(
    response: Response,
    finalUrl: URL,
    abortErrorOf: () => WebFetchError | null,
  ): Promise<WebFetchOutcome> {
    const contentType = response.headers.get("content-type");
    const kind = classifyContentType(contentType);
    if (kind === undefined) {
      await response.body?.cancel();
      throw new WebFetchError(`不支持的内容类型 "${contentType ?? "unknown"}"`, "unsupported_content_type");
    }

    // 解码器在读 body 之前解析，不支持的字符集不消耗流；失败路径仍取消 body 防泄漏。
    let decoder: TextDecoder;
    try {
      decoder = decoderForCharset(parseCharset(contentType));
    } catch (error: unknown) {
      await response.body?.cancel();
      throw error;
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, abortErrorOf);
    const decoded = decoder.decode(bytes);
    const truncatedByChars = decoded.length > this.limits.maxBodyChars;
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded;
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      contentType,
      body: { kind, content },
      truncated: truncatedByBytes || truncatedByChars,
    };
  }

  /**
   * 读取响应流至 maxResponseBytes。Content-Length 超上限立即报错；流式增长超
   * 上限则截断（服务端少报长度时仍能得到有界的可用 body）而非整单拒绝。
   */
  private async readCapped(
    response: Response,
    abortErrorOf: () => WebFetchError | null,
  ): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel();
        throw new WebFetchError(`响应超过最大字节数 ${this.limits.maxResponseBytes}`, "too_large");
      }
    }

    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false };

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncatedByBytes = false;
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = this.limits.maxResponseBytes - total;
        // 只有被丢弃的字节才计为截断：恰好填满容量的 chunk 保留全部字节并继续
        // 读至 EOF，恰好等于上限的 body 不会被误报截断。
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          truncatedByBytes = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (error: unknown) {
      { const abort = abortErrorOf(); if (abort !== null) throw Object.assign(abort, { cause: error }); }
      throw new WebFetchError(`web fetch 读取失败: ${errorMessage(error)}`, "provider_error", { cause: error });
    } finally {
      await reader.cancel().catch(() => {
        // 读取完成/中断后的 cancel 是尽力而为的清理。
      });
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncatedByBytes };
  }
}

/** 携带 Location 的重定向状态码。 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/* ============================================================
 * 代理环境路由（对齐 deepseek-harness http-proxy/policy 语义的最小子集）
 * ========================================================== */

/** 每个策略字段拥有的环境变量名（小写优先，undici 同序读取，读写成对）。 */
const PROXY_ENV_NAMES = {
  http: ["http_proxy", "HTTP_PROXY"],
  https: ["https_proxy", "HTTPS_PROXY"],
  all: ["all_proxy", "ALL_PROXY"],
  no: ["no_proxy", "NO_PROXY"],
} as const;

/** 回环永远直连：本机回环走代理会把本地 UI/测试服务变成路由环路。 */
const ALWAYS_DIRECT_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 解析该 URL 应走的代理 URL；null = 直连（随后进入公网解析+钉扎路径）。
 * 仅支持 http(s) 代理；socks 代理显式报错而不是静默直连。
 */
function proxyUrlFor(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (ALWAYS_DIRECT_HOSTS.has(host)) return null;
  const noProxy = readEnv(PROXY_ENV_NAMES.no) ?? "";
  if (noProxyMatches(noProxy, host)) return null;
  const names = url.protocol === "https:" ? [PROXY_ENV_NAMES.https, PROXY_ENV_NAMES.all] : [PROXY_ENV_NAMES.http, PROXY_ENV_NAMES.all];
  for (const candidates of names) {
    const value = readEnv(candidates)?.trim();
    if (!value) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (error: unknown) {
      throw new WebFetchError(`代理 URL 非法: ${value}`, "provider_error", { cause: error });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebFetchError(`代理协议不支持（${parsed.protocol}；本工具不支持 socks 代理）`, "provider_error");
    }
    return parsed.toString();
  }
  return null;
}

function readEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/** NO_PROXY 简化匹配：`*` 全放行；主机全等或域名后缀匹配（前导 "." 的裸后缀也认）。 */
function noProxyMatches(noProxy: string, hostname: string): boolean {
  const value = noProxy.trim().toLowerCase();
  if (!value) return false;
  if (value === "*") return true;
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  return value.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((entry) => {
      const suffix = entry.startsWith(".") ? entry : `.${entry}`;
      return host === entry || host.endsWith(suffix);
    });
}

/** 经代理转发一次请求；代理连接自身的生命周期与该请求一致。 */
async function requestViaProxy(
  proxyUrl: string,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ response: Response; close(): Promise<void> }> {
  const dispatcher = new ProxyAgent(proxyUrl);
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", headers, signal, dispatcher });
    return { response, close: async () => { await dispatcher.close(); } };
  } catch (error: unknown) {
    await dispatcher.close();
    throw error;
  }
}

/** 相对 Location 以当前 URL 为基准解析。 */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch (error: unknown) {
    throw new WebFetchError(`非法重定向 Location "${location}"`, "provider_error", { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

