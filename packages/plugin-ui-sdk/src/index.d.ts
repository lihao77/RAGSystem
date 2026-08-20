/**
 * 插件 UI bundle 契约（apiVersion 1）。
 *
 * bundle 是一个 ESM 模块（同源 URL，由插件自己的路由伺服），必须导出 mountView。
 * 宿主（frontend-client 的 PluginViewHost）负责提供 DOM 容器与 host 上下文；
 * 插件在容器内自建 Vue app（bundle 自带 Vue 运行时，不与宿主共享实例/依赖），
 * 因此组件间不使用 provide/inject，一切交互经 host 上下文（props 注入）。
 */

export interface PluginUiApi {
  get<T = unknown>(url: string): Promise<T>;
  post<T = unknown>(url: string, body?: unknown): Promise<T>;
  put<T = unknown>(url: string, body?: unknown): Promise<T>;
  patch<T = unknown>(url: string, body?: unknown): Promise<T>;
  del<T = unknown>(url: string): Promise<T>;
}

/** plugin_event 下行帧的只读视图（来自会话 WS，宿主侧 reactive 快照）。 */
export interface PluginUiEventFrame {
  readonly plugin_id: string;
  readonly event: string;
  readonly data: unknown;
  readonly delivery: string;
  readonly at: number;
}

export interface PluginUiEvents {
  /** 本插件某事件的最近一帧；无则 null。data 按不可信数据处理。 */
  latest(event: string): PluginUiEventFrame | null;
}

export interface PluginUiViewInfo {
  readonly route: string;
  readonly entry: string;
  readonly title?: string;
}

export interface PluginUiHostContext {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly view: PluginUiViewInfo;
  /** 同源 API 客户端（自动携带当前登录态；public 端点亦可直接 fetch）。 */
  readonly api: PluginUiApi;
  readonly events: PluginUiEvents;
}

/** mountView 返回的卸载句柄；无返回值视为无需清理。 */
export interface PluginUiViewHandle {
  unmount(): void;
}

/**
 * bundle 唯一必需导出：把插件 view 挂到给定元素上。
 * 同步抛错或返回无效值时宿主展示错误卡片（不殃及宿主应用）。
 */
export type MountPluginUiView = (
  element: HTMLElement,
  host: PluginUiHostContext,
) => PluginUiViewHandle | void;
