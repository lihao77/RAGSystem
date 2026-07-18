import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "RAGSystem 使用与开发手册",
  description: "RAGSystem 使用、接口、架构与运维手册",
  lastUpdated: true,
  cleanUrls: true,
  head: [["meta", { name: "theme-color", content: "#3aa675" }]],
  search: {
    provider: "local",
    options: {
      translations: {
        button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
        modal: { displayDetails: "显示详情", resetButtonTitle: "清除查询", backButtonTitle: "返回", noResultsText: "没有结果", footer: { selectText: "选择", navigateUpKeyAriaLabel: "上一个", navigateDownKeyAriaLabel: "下一个", closeText: "关闭", closeKeyAriaLabel: "关闭" } },
      },
    },
  },
  themeConfig: {
    outline: { level: [2, 3], label: "本页导航" },
    docFooter: { prev: "上一页", next: "下一页" },
    lastUpdatedText: "最后更新",
    nav: [
      { text: "开始使用", link: "/00-start/" },
      { text: "概念", link: "/01-concepts/" },
      { text: "架构", link: "/02-architecture/" },
      { text: "指南", link: "/03-guides/" },
      { text: "API", link: "/04-api/" },
      { text: "SDK", link: "/05-sdk/" },
      { text: "运维", link: "/06-operations/" },
      { text: "ADR", link: "/07-adr/" },
    ],
    sidebar: {
      "/00-start/": [{ text: "开始使用", items: [{ text: "总览", link: "/00-start/" }, { text: "安装与启动", link: "/00-start/getting-started" }] }],
      "/01-concepts/": [{ text: "核心概念", items: [{ text: "概念总览", link: "/01-concepts/" }] }],
      "/02-architecture/": [{ text: "架构", items: [
        { text: "总览", link: "/02-architecture/" }, { text: "系统上下文", link: "/02-architecture/system-context" }, { text: "容器架构", link: "/02-architecture/container-architecture" }, { text: "后端组件", link: "/02-architecture/components" }, { text: "关键时序", link: "/02-architecture/sequences" }, { text: "数据与存储", link: "/02-architecture/data-and-storage" }, { text: "Agent 运行时", link: "/02-architecture/agent-runtime" }, { text: "TS 后端分层", link: "/02-architecture/backend-ts-layer" }, { text: "前端架构", link: "/02-architecture/frontend" }, { text: "工具系统", link: "/02-architecture/tool-system" }, { text: "存储模型", link: "/02-architecture/storage" }, { text: "Local/SaaS 迁移路线", link: "/02-architecture/local-saas-migration-roadmap" },
      ] }],
      "/03-guides/": [{ text: "指南", items: [
        { text: "总览", link: "/03-guides/" }, { text: "配置", link: "/03-guides/configuration" }, { text: "Memory", link: "/03-guides/memory" }, { text: "知识库", link: "/03-guides/knowledge-base" }, { text: "RAG 生命周期", link: "/03-guides/rag-pipeline" }, { text: "Agent 与 Team", link: "/03-guides/agents" }, { text: "MCP", link: "/03-guides/mcp" }, { text: "模型 Provider", link: "/03-guides/model-providers" }, { text: "Widget", link: "/03-guides/widget" }, { text: "运行时数据", link: "/03-guides/runtime-data-layout" },
      ] }],
      "/04-api/": [{ text: "API", items: [
        { text: "总览", link: "/04-api/" }, { text: "HTTP", link: "/04-api/http" }, { text: "Memory API", link: "/04-api/memory" }, { text: "接口约定", link: "/04-api/conventions" }, { text: "路由矩阵", link: "/04-api/route-matrix" }, { text: "WebSocket 与事件", link: "/04-api/websocket-events" }, { text: "AG-UI", link: "/04-api/agui" }, { text: "错误模型", link: "/04-api/errors" }, { text: "agent-protocol", link: "/04-api/agent-protocol" },
      ] }],
      "/05-sdk/": [{ text: "SDK", items: [{ text: "总览", link: "/05-sdk/" }, { text: "Agent 开发", link: "/05-sdk/agent-development" }, { text: "共享包", link: "/05-sdk/shared-packages" }] }],
      "/06-operations/": [{ text: "运维", items: [{ text: "总览", link: "/06-operations/" }, { text: "生产运维", link: "/06-operations/operations" }, { text: "部署模式", link: "/06-operations/deployment" }, { text: "故障排查", link: "/06-operations/troubleshooting" }, { text: "安全基线", link: "/06-operations/security" }, { text: "桌面端", link: "/06-operations/desktop" }] }],
      "/07-adr/": [{ text: "架构决策", items: [{ text: "总览", link: "/07-adr/" }, { text: "Tenant Runtime", link: "/07-adr/001-tenant-runtime" }, { text: "Durable Outbox", link: "/07-adr/002-durable-outbox" }, { text: "共享协议", link: "/07-adr/003-shared-protocol" }] }],
    },
    footer: { message: "内容以当前仓库源码、package.json、schema 和测试为准。", copyright: "MIT License" },
  },
});
