/**
 * 执行树展示视图构建：core ExecutionTree → TreeNode[]（前端渲染消费）。
 *
 * core 投影（execution-tree.ts）产 ExecutionAgent/Round/ToolCall（协议投影真相源）；
 * 本文件只做形状映射 + 注入展示态（expanded），不重建树——投影逻辑只在 core 一份。
 *
 * core 模型：agent 是父 agent 某 round 的 toolCall，child agent 是父 agent 的 children（分开）。
 * 主执行树只保留 child 的 delegation reference；child 的完整 rounds/messages
 * 通过 Participant thread 查看，避免在 root 时间线递归展开整棵子树。
 * 遇到 agent toolCall 时，仍按 invocationCallId 精确匹配 child；
 * 匹配不到则保留普通 tool_call，未匹配的 child 作为独立 agent_call 追加，不按名称猜测。
 */

import { parseTaskNotificationContent } from './message-render.js';

const mapStatus = (status) => {
  if (status === 'running') return 'running';
  if (status === 'failed') return 'error';
  if (status === 'succeeded') return 'success';
  return status || 'running';
};

const createToolNode = (toolCall) => ({
  type: 'tool_call',
  call_id: toolCall.callId,
  tool_name: toolCall.toolName,
  arguments: toolCall.arguments || {},
  status: mapStatus(toolCall.status),
  result: toolCall.observation || toolCall.summary || '',
  result_preview: toolCall.observation || toolCall.summary || '',
  approval_message: toolCall.approval?.message || '',
  elapsed_time: typeof toolCall.elapsedMs === 'number' ? toolCall.elapsedMs / 1000 : null,
  expanded: false,
});

// 注入节点：run 进行中到达的 followup(用户插话)。
// 非协议事件,不进 core execution-tree；仅前端 TreeNode 层呈现,挂 root agent children 末尾(final answer 之前)。
// background_notification 的 notifications 字段为通道 B 预留:当前 INJECTION_SOURCES 只 running_session
// (通知走通道 A 顶层 UserMessage 渲染);待后端 refresh 激活通道 B(通知注入当前 run)后扩展启用。
const createInjectionNode = (msg) => {
  const source = msg.metadata?.source || '';
  return {
    type: 'injection',
    injection_kind: source,
    message_id: msg.id || null,
    seq: typeof msg.seq === 'number' ? msg.seq : null,
    content: msg.content || '',
    status: 'success',
    // 通道 B 预留(当前 INJECTION_SOURCES 未含 background_notification,不触发)。
    notifications: source === 'background_notification'
      ? parseTaskNotificationContent(msg.content)
      : null,
  };
};

const createAgentMessageNode = (message) => ({
  type: 'agent_message',
  message_id: message.messageId,
  message_kind: message.kind,
  content: message.content || '',
  source_run_id: message.sourceRunId || null,
  source_agent_call_id: message.sourceAgentCallId || null,
  correlation_id: message.correlationId || null,
  reply_to_message_id: message.replyToMessageId || null,
  metadata: message.metadata || {},
  status: 'success',
});

const createAgentCallNode = (agent, toolCall = null) => ({
  type: 'agent_call',
  task_id: agent.callId,
  agent_name: agent.agentId,
  agent_display_name: agent.displayName || agent.agentId,
  description: agent.task || '',
  result_summary: agent.output || agent.result || '',
  status: mapStatus(agent.status),
  expanded: false,
  ctx: agent.ctx || null,
  participant_id: agent.participantId
    || toolCall?.arguments?.child_agent_id
    || toolCall?.arguments?.childAgentId
    || null,
  is_reference: true,
  children: [],
});

const isDelegateTool = (toolName) => toolName === 'agent';

/**
 * 构建一个 agent 的子节点：rounds → thought(intent) + tool_call/agent_call；未消费 children → agent_call。
 * consumedChildIds 追踪当前 agent.children 的消费（避免 agent 合并后重复出现）。
 */
function buildAgentChildren(agent, consumedChildIds, injections = []) {
  const children = [];
  const pendingInjections = injections ? [...injections] : [];
  const childByInvocationCallId = new Map();
  for (const child of agent.children || []) {
    const invocationCallId = child.invocationCallId;
    if (invocationCallId && !childByInvocationCallId.has(invocationCallId)) {
      childByInvocationCallId.set(invocationCallId, child);
    }
  }
  for (const round of agent.rounds || []) {
    const roundChildren = [];
    for (const toolCall of round.toolCalls || []) {
      if (isDelegateTool(toolCall.toolName)) {
        const child = childByInvocationCallId.get(toolCall.callId);
        if (child && !consumedChildIds.has(child.callId)) {
          consumedChildIds.add(child.callId);
          roundChildren.push(createAgentCallNode(child, toolCall));
        } else {
          roundChildren.push(createToolNode(toolCall));
        }
      } else {
        roundChildren.push(createToolNode(toolCall));
      }
    }

    // 有 intent 的 round 包 thought(显示思考内容,每个思考自然标识一个 round 的开始);无 intent 的工具直接平级,
    // 不为无 intent 的 round 造空 thought 节点。不显示"轮次 N"号(round 归属靠思考节点 + injection 位置体现)。
    const hasIntent = Boolean(round.intent);
    if (hasIntent) {
      children.push({
        type: 'thought',
        agent: agent.agentId,
        agent_display_name: agent.displayName || agent.agentId,
        round: round.round,
        intent: round.intent || '',
        intent_complete: round.intentComplete !== false,
        status: round.intentComplete === false || round.toolCalls?.some(t => t.status === 'running')
          ? 'running'
          : 'success',
        children: roundChildren,
      });
    } else {
      children.push(...roundChildren);
    }
    // 该 round 之后:插入 round_index 匹配的 injection(followup 到达于此 round,agent 后续 round 才响应)。
    for (let i = pendingInjections.length - 1; i >= 0; i--) {
      if (pendingInjections[i].metadata?.round_index === round.round) {
        children.push(createInjectionNode(pendingInjections[i]));
        pendingInjections.splice(i, 1);
      }
    }
  }

  for (const message of agent.messages || []) {
    children.push(createAgentMessageNode(message));
  }

  // 未被 agent 合并消费的 child agent：作为独立 agent_call 追加
  for (const child of agent.children || []) {
    if (!consumedChildIds.has(child.callId)) {
      consumedChildIds.add(child.callId);
      children.push(createAgentCallNode(child));
    }
  }
  // 剩余 injection(无 round_index 或 round 未匹配,如历史回放老数据):挂末尾(final answer 前)。
  for (const msg of pendingInjections) {
    children.push(createInjectionNode(msg));
  }
  return children;
}

/**
 * @param {Object} executionTree - core ExecutionTree { root: ExecutionAgent|null, steps }
 * @returns {Array} TreeNode[]
 */
export function buildExecutionTree(executionTree, injections = []) {
  // 无执行树(assistant 纯文本回复/还没工具调用)但有注入:仍渲染 injection 节点,不因 tree 空丢失。
  if (!executionTree?.root) {
    return (injections || []).map(createInjectionNode);
  }
  return buildAgentChildren(executionTree.root, new Set(), injections);
}
