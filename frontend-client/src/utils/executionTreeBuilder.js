/**
 * 执行树展示视图构建：core ExecutionTree → TreeNode[]（前端渲染消费）。
 *
 * core 投影（execution-tree.ts）产 ExecutionAgent/Round/ToolCall（协议投影真相源）；
 * 本文件只做形状映射 + 注入展示态（expanded），不重建树——投影逻辑只在 core 一份。
 *
 * core 模型：call_agent 是父 agent 某 round 的 toolCall，child agent 是父 agent 的 children（分开）。
 * 为保留旧 UI 的"合并 agent_call 节点"视觉，遇到 call_agent/send_message toolCall 时，
 * 按 toolCall.input.agent_name 在父 agent.children 匹配未消费的 child，合并为 agent_call 节点；
 * 匹配不到则作为普通 tool_call，未匹配的 child 退化为顶层 agent_call。
 */

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
  raw_result: null,
  raw_result_ref: toolCall.rawResultRef || null,
  raw_result_available: Boolean(toolCall.rawResultRef),
  approval_message: toolCall.approval?.message || '',
  elapsed_time: typeof toolCall.elapsedMs === 'number' ? toolCall.elapsedMs / 1000 : null,
  expanded: false,
  linked_task_id: null,
});

const createAgentCallNode = (agent) => ({
  type: 'agent_call',
  task_id: agent.callId,
  agent_name: agent.agentId,
  agent_display_name: agent.displayName || agent.agentId,
  description: agent.task || '',
  result_summary: agent.output || agent.result || '',
  status: mapStatus(agent.status),
  expanded: false,
  ctx: agent.ctx || null,
  children: buildAgentChildren(agent, new Set()),
});

const isDelegateTool = (toolName) => toolName === 'call_agent' || toolName === 'send_message';

const readInputAgentName = (toolCall) => {
  const input = toolCall.arguments && typeof toolCall.arguments === 'object' ? toolCall.arguments : {};
  const agentName = input.agent_name;
  return typeof agentName === 'string' && agentName.length > 0 ? agentName : null;
};

/**
 * 构建一个 agent 的子节点：rounds → thought(intent) + tool_call/agent_call；未消费 children → agent_call。
 * consumedChildIds 追踪当前 agent.children 的消费（避免 call_agent 合并后重复出现）。
 */
function buildAgentChildren(agent, consumedChildIds) {
  const children = [];
  for (const round of agent.rounds || []) {
    const roundChildren = [];
    for (const toolCall of round.toolCalls || []) {
      if (isDelegateTool(toolCall.toolName)) {
        const targetAgentName = readInputAgentName(toolCall);
        const child = (agent.children || []).find(
          c => !consumedChildIds.has(c.callId) && (targetAgentName == null || c.agentId === targetAgentName),
        );
        if (child) {
          consumedChildIds.add(child.callId);
          roundChildren.push(createAgentCallNode(child));
        } else {
          roundChildren.push(createToolNode(toolCall));
        }
      } else {
        roundChildren.push(createToolNode(toolCall));
      }
    }

    const hasIntent = Boolean(round.intent);
    if (hasIntent) {
      children.push({
        type: 'thought',
        agent: agent.agentId,
        agent_display_name: agent.displayName || agent.agentId,
        round: round.round,
        intent: round.intent || '',
        status: round.toolCalls?.some(t => t.status === 'running') ? 'running' : 'success',
        children: roundChildren,
      });
    } else {
      children.push(...roundChildren);
    }
  }

  // 未被 call_agent 合并消费的 child agent：作为独立 agent_call 追加
  for (const child of agent.children || []) {
    if (!consumedChildIds.has(child.callId)) {
      consumedChildIds.add(child.callId);
      children.push(createAgentCallNode(child));
    }
  }
  return children;
}

/**
 * @param {Object} executionTree - core ExecutionTree { root: ExecutionAgent|null, steps }
 * @returns {Array} TreeNode[]
 */
export function buildExecutionTree(executionTree) {
  if (!executionTree?.root) return [];
  return buildAgentChildren(executionTree.root, new Set());
}
