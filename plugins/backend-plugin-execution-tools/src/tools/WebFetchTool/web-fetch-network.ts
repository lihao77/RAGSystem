/**
 * 公网解析与地址钉扎的 HTTP 传输（对齐 deepseek-harness web-fetch-http/network.ts）。
 *
 * DNS 应答集先整体校验（任一目的地非公网即拒绝），随后把校验过的地址集通过
 * 自定义 lookup 交给 undici——连接不可能再解析到私网地址（防 DNS rebinding）。
 * URL hostname 保持原样，HTTP Host 与 TLS SNI 不受影响。gzip/br 等内容编码
 * 由 undici fetch 自动解压（旧手写 http client 的压缩乱码根因）。
 */
import { lookup as systemLookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import type { Response } from "undici";
import ipaddr from "ipaddr.js";
import { WebFetchError } from "./web-fetch-policy.js";

/** 一个已解析并保留给后续钉扎连接的地址。 */
export interface PublicAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** 一次请求的结果；close() 释放该请求私有的 dispatcher。 */
export interface PinnedResponse {
  readonly response: Response;
  close(): Promise<void>;
}

/** 解析器签名——测试可注入假解析器以覆盖公网策略（不改动进程 DNS）。 */
export type AddressResolver = (hostname: string, options: { all: true; order: "verbatim" }) => Promise<LookupAddress[]>;

/** RFC 6052 可承载 IPv4 目的地的 NAT64 前缀长度。 */
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;
const IPV4ONLY_DISCOVERY_HOST = "ipv4only.arpa";
const IPV4ONLY_SENTINELS = new Set(["192.0.0.170", "192.0.0.171"]);

interface Nat64Prefix {
  readonly bytes: readonly number[];
  readonly length: (typeof RFC6052_PREFIX_LENGTHS)[number];
}

/**
 * 地址是否为全局可达单播。IPv4-mapped IPv6 按其内嵌 IPv4 分类；转换/过渡前缀
 * 一律拒绝（其最终 IPv4 目的地无法在此钉扎）。
 */
export function isPublicIpAddress(input: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input));
  } catch {
    return false;
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === "unicast";
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === "unicast";
  return parsed.range() === "unicast";
}

/**
 * 消费级代理（Clash/sing-box/Surge 等 TUN + fake-ip 模式）约定的虚拟 IP 段：
 * 198.18.0.0/15（IETF 基准测试保留段）。该模式下的系统 DNS 把所有外部域名
 * 解析到本段，连接由 OS TUN 网卡拦截转发给代理——段内不存在真实服务，
 * 拦截它只会让所有 fake-ip 部署完全不可用，放行的攻击面近乎为零（回环/
 * 私网/链路本地/组播等真正承载服务的段仍然拒绝）。
 */
function isFakeIpProxyAddress(input: string): boolean {
  try {
    const parsed = ipaddr.parse(stripIpv6Brackets(input));
    if (!(parsed instanceof ipaddr.IPv4)) return false;
    const [first, second] = parsed.octets;
    return first === 198 && (second === 18 || second === 19);
  } catch {
    return false;
  }
}

/**
 * 解析一次 hostname，任一目的地非公网则拒绝整个应答集。返回的地址集是传输
 * 唯一可用的地址。
 */
export async function resolvePublicAddresses(
  hostname: string,
  signal: AbortSignal,
  resolver: AddressResolver = systemLookup,
): Promise<PublicAddress[]> {
  const unbracketed = stripIpv6Brackets(hostname);
  const literalFamily = isIP(unbracketed);
  const resolved = literalFamily === 0
    ? await raceWithSignal(resolver(unbracketed, { all: true, order: "verbatim" }), signal)
    : [{ address: unbracketed, family: literalFamily }];

  if (resolved.length === 0) {
    throw new WebFetchError(`hostname "${hostname}" 未解析到任何地址`, "provider_error");
  }

  const hasIpv6 = resolved.some((entry) => entry.family === 6 && isIP(entry.address) === 6);
  const nat64Prefixes = hasIpv6
    ? await discoverNat64Prefixes(signal, resolver)
    : [];

  const addresses: PublicAddress[] = [];
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebFetchError(`hostname "${hostname}" 解析到非法 IP 地址`, "provider_error");
    }
    if (!isPublicIpAddress(entry.address) && !isFakeIpProxyAddress(entry.address)) {
      throw new WebFetchError(`URL hostname "${hostname}" 解析到非公网 IP 地址`, "blocked_url");
    }
    const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes);
    if (translatedIpv4 !== undefined && !isPublicIpAddress(translatedIpv4)) {
      throw new WebFetchError(`URL hostname "${hostname}" 经 NAT64 解析到非公网 IPv4 地址`, "blocked_url");
    }
    addresses.push({ address: entry.address, family: entry.family });
  }
  return addresses;
}

/** 用 RFC 7050 保留主机名发现当前 DNS64 前缀集。 */
async function discoverNat64Prefixes(signal: AbortSignal, resolver: AddressResolver): Promise<Nat64Prefix[]> {
  const discovered = await raceWithSignal(
    resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: "verbatim" }),
    signal,
  );
  const prefixes: Nat64Prefix[] = [];
  const seen = new Set<string>();
  for (const entry of discovered) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue;
    const bytes = ipaddr.parse(entry.address).toByteArray();
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length);
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue;
      const prefixBytes = bytes.slice(0, length / 8);
      const key = `${String(length)}:${prefixBytes.join(".")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      prefixes.push({ bytes: prefixBytes, length });
    }
  }
  return prefixes;
}

/** IPv6 地址命中已发现前缀时返回其 RFC 6052 内嵌 IPv4 地址。 */
function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6) return undefined;
  const bytes = ipaddr.parse(input).toByteArray();
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue;
    const embedded = embeddedIpv4Address(bytes, prefix.length);
    if (embedded !== undefined) return embedded;
  }
  return undefined;
}

/** 从 RFC 6052 IPv6 布局提取一个 IPv4 地址。 */
function embeddedIpv4Address(bytes: readonly number[], prefixLength: Nat64Prefix["length"]): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join(".");
  if (bytes[8] !== 0) return undefined;
  const prefixBytes = prefixLength / 8;
  const beforeReservedOctet = 8 - prefixBytes;
  const ipv4 = [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet),
    ...bytes.slice(9, 9 + 4 - beforeReservedOctet),
  ];
  return ipv4.join(".");
}

/**
 * 通过自定义 lookup 只返回已校验地址集的 Agent 发起请求。Agent 属于本次请求
 * 私有——钉扎是本工具拒绝"校验与连接之间 DNS 应答变化"的手段，只作用于模型
 * 可选 URL 的请求，不进程级生效（本机回环上的 MCP server/模型端点是合法目的地）。
 */
export async function requestPinned(
  url: URL,
  addresses: readonly PublicAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } });
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", headers, signal, dispatcher });
    return { response, close: async () => { await dispatcher.close(); } };
  } catch (error: unknown) {
    await dispatcher.close();
    throw error;
  }
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 构建不做任何网络解析、只服务固定已校验应答集的连接 lookup。 */
export function createPinnedLookup(addresses: readonly PublicAddress[]): (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const family = typeof options.family === "number"
      ? options.family
      : options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : 0;
    const eligible = family === 0 ? addresses : addresses.filter((address) => address.family === family);
    const selected = eligible[0];
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), {
        code: "ENOTFOUND",
        hostname,
      });
      callback(error, options.all === true ? [] : "", family);
      return;
    }
    if (options.all === true) {
      callback(null, eligible.map((address) => ({ ...address })));
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

/** 让不可取消的 OS 解析不阻塞工具取消。抛普通 Error——中止/超时的分类由 client 统一判定。 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new Error("web fetch aborted during hostname resolution", { cause: signal.reason });
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(abortError()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", abort); });
  });
}

/** WHATWG URL 保留 IPv6 主机名的方括号；IP 解析器不认。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
