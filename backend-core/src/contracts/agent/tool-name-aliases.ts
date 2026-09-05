/**
 * 退役工具名注册表（插件声明、core 聚合）。
 *
 * 工具名的所有权在插件（core 不硬编码任何插件工具名）；插件在自己的
 * BackendToolDescriptor.retired_names 里声明历史名，plugin-manager 注册描述符时
 * 把映射灌进本注册表，配置归一层（normalizeConfig / 会话快照 preprocess）再消费。
 *
 * 时序保证：buildCoreApp 中 pluginManager.register() 先于部署容器构建（agent 配置
 * 水合发生处），水合读到的注册表必然已填充。注册表只增不删——退役名是历史事实，
 * 插件卸载不回收。写入幂等（同现名重复声明覆盖），无并发写场景（均在启动期）。
 */
const aliases = new Map<string, string>();

/** 声明某工具的历史名（retired → current）。重复声明后者生效。 */
export function registerRetiredToolNames(current: string, retired: readonly string[]): void {
  for (const name of retired) {
    aliases.set(name, current);
  }
}

/** 当前聚合快照（retired → current）。 */
export function retiredToolNameAliases(): Readonly<Record<string, string>> {
  // null 原型：调用点用 `in` 判成员、用 `??` 取值，"toString"/"constructor" 等
  // 原型链名字不得被误当作已注册的退役名。
  return Object.assign(Object.create(null), Object.fromEntries(aliases));
}
