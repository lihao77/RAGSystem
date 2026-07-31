import { createRagChatClient } from '@ragsystem/chat-sdk-core';

import { useAuthStore } from '../stores/auth.js';
import { getHostTool, getHostToolDeclarations } from '../utils/hostTools.js';

/**
 * Frontend-owned SDK factory. The SDK owns transport/protocol details; the
 * caller still owns Pinia state, message projection and UI interaction.
 */
export function createFrontendChatSdk(options = {}) {
  const authStore = useAuthStore();
  const hostTools = getHostToolDeclarations().map((declaration) => ({
    name: declaration.name,
    description: declaration.description,
    inputSchema: declaration.input_schema,
    ...(declaration.risk_level ? { riskLevel: declaration.risk_level } : {}),
    async execute(input, context) {
      const tool = getHostTool(declaration.name);
      if (!tool) return { ok: false, error: `前端未注册委托工具: ${declaration.name}` };
      return tool.execute(input, context);
    },
  }));

  return createRagChatClient({
    baseUrl: options.baseUrl ?? '',
    getToken: () => authStore.token || undefined,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.createWebSocket ? { createWebSocket: options.createWebSocket } : {}),
    hostTools,
    aguiFallback: true,
  });
}
