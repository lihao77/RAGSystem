import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionTree, getAgentOperationTitle } from './executionTreeBuilder.js';

const tool = (callId, toolName, argumentsValue = {}) => ({
  callId,
  toolName,
  arguments: argumentsValue,
  status: 'succeeded',
});

const child = (callId, invocationCallId, task, agentId = 'worker') => ({
  callId,
  invocationCallId,
  agentId,
  task,
  status: 'succeeded',
  rounds: [],
  children: [],
});

const treeWith = (toolCalls, children) => ({
  root: {
    callId: 'root-call',
    agentId: 'root',
    status: 'succeeded',
    rounds: [{ round: 0, intent: 'delegate', toolCalls }],
    children,
  },
  steps: [],
});

test('keeps repeated delegation tools and links children by invocation call id', () => {
  const tree = treeWith(
    [
      tool('tool-first', 'agent', { agent_name: 'worker', message: 'first task' }),
      tool('tool-second', 'agent', { agent_name: 'worker', message: 'second task' }),
    ],
    [
      child('agent-second', 'tool-second', 'second task'),
      child('agent-first', 'tool-first', 'first task'),
    ],
  );

  const [thought] = buildExecutionTree(tree);
  assert.deepEqual(thought.children.map((node) => node.call_id), ['tool-first', 'tool-second']);
  assert.deepEqual(thought.children.map((node) => node.type), ['tool_call', 'tool_call']);
  assert.deepEqual(
    thought.children.map((node) => node.linked_agent_call.task_id),
    ['agent-first', 'agent-second'],
  );
});

test('matches an existing child agent without relying on agent_name arguments', () => {
  const tree = treeWith(
    [tool('tool-resume', 'agent', { child_agent_id: 'child-1', message: 'continue task' })],
    [child('agent-resume', 'tool-resume', 'continue task')],
  );

  const [thought] = buildExecutionTree(tree);
  assert.equal(thought.children[0].type, 'tool_call');
  assert.equal(thought.children[0].agent_operation.type, 'resume_child');
  assert.equal(thought.children[0].linked_agent_call.task_id, 'agent-resume');
});

test('keeps ambiguous legacy child separate instead of guessing by name', () => {
  const tree = treeWith(
    [tool('tool-delegate', 'agent', { agent_name: 'worker', message: 'delegate task' })],
    [child('unrelated-agent-call', null, 'unlinked task')],
  );

  const nodes = buildExecutionTree(tree);
  assert.equal(nodes[0].children[0].type, 'tool_call');
  assert.equal(nodes[0].children[0].call_id, 'tool-delegate');
  assert.equal(nodes[1].type, 'agent_call');
  assert.equal(nodes[1].task_id, 'unrelated-agent-call');
});

test('renders durable agent messages as distinct execution nodes', () => {
  const tree = treeWith([], []);
  tree.root.messages = [{
    messageId: 'message-1',
    kind: 'result',
    content: 'child finished',
    sourceRunId: 'child-run',
    sourceAgentCallId: 'child-call',
  }];

  const nodes = buildExecutionTree(tree);
  const message = nodes[nodes.length - 1];
  assert.equal(message.type, 'agent_message');
  assert.equal(message.message_kind, 'result');
  assert.equal(message.content, 'child finished');
});

test('keeps child execution as a reference instead of nesting its full tree', () => {
  const nested = child('nested', null, 'nested task');
  nested.rounds = [{ round: 0, intent: 'internal', toolCalls: [tool('nested-tool', 'search')] }];
  const tree = treeWith(
    [tool('delegate', 'agent', { agent_name: 'worker', message: 'delegate' })],
    [child('worker-run', 'delegate', 'delegate', 'worker')],
  );
  tree.root.children[0].children = [nested];
  tree.root.children[0].participantId = 'child-worker';

  const node = buildExecutionTree(tree)[0].children[0];
  assert.equal(node.type, 'tool_call');
  assert.equal(node.linked_agent_call.participant_id, 'child-worker');
  assert.equal(node.agent_operation.type, 'create_child');
});

test('projects all agent operations as explicit tool facts with stable titles', () => {
  const operationTools = [
    tool('create', 'agent', { agent_name: 'worker', message: 'inspect' }),
    tool('resume', 'agent', { child_agent_id: 'child-1', message: 'continue' }),
    tool('message-child', 'agent', { child_agent_id: 'child-2', message: 'status' }),
    tool('message-parent', 'agent', { message: 'done' }),
  ];
  operationTools[1].agentOperation = { type: 'resume_child', agent_name: 'Worker' };
  operationTools[2].agentOperation = { type: 'message_child', child_agent_id: 'child-2', delivery_status: 'queued' };
  operationTools[3].agentOperation = { type: 'message_parent', delivery_status: 'queued' };
  const tree = treeWith(operationTools, [child('worker-call', 'create', 'inspect', 'worker')]);

  const nodes = buildExecutionTree(tree)[0].children;

  assert.deepEqual(nodes.map(node => node.type), ['tool_call', 'tool_call', 'tool_call', 'tool_call']);
  assert.deepEqual(nodes.map(getAgentOperationTitle), [
    '委派给 worker',
    '继续 Worker',
    '向 child-2 发送消息',
    '回复主智能体',
  ]);
  assert.equal(nodes[0].linked_agent_call.task_id, 'worker-call');
});

test('does not mislabel an ambiguous legacy agent failure as a parent reply', () => {
  const tree = treeWith([tool('invalid', 'agent', { message: 'missing target' })], []);
  const node = buildExecutionTree(tree)[0].children[0];

  assert.equal(getAgentOperationTitle(node), '智能体操作');
});

test('preserves intent completion so inline rendering only streams the active intent', () => {
  const tree = treeWith([], []);
  tree.root.rounds[0].intentComplete = false;

  const [thought] = buildExecutionTree(tree);
  assert.equal(thought.intent_complete, false);
  assert.equal(thought.status, 'running');

  tree.root.rounds[0].intentComplete = true;
  const [completedThought] = buildExecutionTree(tree);
  assert.equal(completedThought.intent_complete, true);
  assert.equal(completedThought.status, 'success');
});
