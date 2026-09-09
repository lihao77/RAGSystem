/**
 * `@joplin/turndown-plugin-gfm` 的环境模块声明——该包不带类型也没有
 * DefinitelyTyped 包。只声明复合 `gfm` 插件；包内的单件插件（tables/
 * strikethrough…）在有人导入前保持未声明。
 */
declare module "@joplin/turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  /** 复合 GitHub-flavored-markdown 插件（表格、删除线、任务列表、高亮代码块）。 */
  export const gfm: TurndownService.Plugin;
}
