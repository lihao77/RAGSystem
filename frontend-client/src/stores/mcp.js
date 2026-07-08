import { defineStore } from 'pinia';
import { ref } from 'vue';
import { listAllMCPPrompts } from '../api/mcpService';

/**
 * MCP 全局状态:聚合所有已连接 server 的 prompts(供命令面板注册动态命令)。
 * MCPManager 的 server 变更(连接/断开/增删,都收归 runLoadServers)后调 reloadPrompts,
 * MainLayout watch prompts 自动重注册命令面板——比事件总线更贴合 Pinia 响应式模式。
 */
export const useMcpStore = defineStore('mcp', () => {
  const prompts = ref([]);

  async function reloadPrompts() {
    try {
      const res = await listAllMCPPrompts();
      prompts.value = res.data?.prompts || [];
    } catch { /* MCP 未就绪或无连接 */ }
  }

  return { prompts, reloadPrompts };
});
