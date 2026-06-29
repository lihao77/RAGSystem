/// <reference types="vite/client" />

// Vue SFC 类型声明（tsc 不认 .vue，vite build 能处理）
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
