import { ref } from 'vue';

/**
 * 当前激活会话 id 的单源（llm/thinking 两个 store 共享，避免各自维护一份漂移）。
 * 聊天控制器在切换/新建会话时写入；空串 = 无会话（新会话），会话覆盖层全部失活，
 * 选择器回落到全局个人默认。
 */
const activeSessionId = ref('');

export function setActiveSessionId(sessionId) {
  activeSessionId.value = sessionId || '';
}

/**
 * 用户主动选择（模型/思考档位）的单槽监听：store 的 set* 在状态更新后通知，
 * 由聊天控制器决定是否即时落会话（对齐权限模式"选择即更新"）。
 * 恢复（applySessionOverride）与失效清理（clearSessionOverride）不通知——
 * 那些不是用户选择，写回会造成恢复自触发回环。单槽覆盖式注册，
 * 组合式函数重复初始化/HMR 时后注册者生效。
 */
let selectionChangeListener = null;

export function notifySelectionChanged() {
  try {
    selectionChangeListener?.();
  } catch {
    // 监听方自行兜底异常；通知链路永不影响选择本身
  }
}

export function setSelectionChangeListener(listener) {
  selectionChangeListener = typeof listener === 'function' ? listener : null;
}

export { activeSessionId };
