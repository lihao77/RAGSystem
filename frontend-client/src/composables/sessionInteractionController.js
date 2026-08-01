// @ts-check

/**
 * Validates UI interaction state before delegating transport and ACK handling
 * to chat-sdk.
 *
 * @param {import('./sessionCoreTypes.js').SessionInteractionControllerOptions} options
 */
export function createSessionInteractionController({
  getSessionRuntime,
  respondViaSdk,
}) {
  /** @param {string} interactionId @param {import('./sessionCoreTypes.js').InteractionResponse} response */
  const respond = async (interactionId, response) => {
    const runtime = getSessionRuntime();
    if (!runtime?.allowed_actions?.includes('respond_interaction')) {
      throw new Error('当前 Session runtime 不允许响应交互');
    }
    const pending = Array.isArray(runtime.pending_interactions) ? runtime.pending_interactions : [];
    if (!pending.some(item => item?.interaction_id === interactionId)) {
      throw new Error('交互请求已失效，请等待 Session runtime 刷新');
    }
    if (!respondViaSdk) throw new Error('Chat SDK 未初始化');
    await respondViaSdk(interactionId, response);
  };

  return {
    respond,
    hasPending: () => false,
    resolve: () => false,
    reject: () => false,
    reset: () => {},
  };
}
