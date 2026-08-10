import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionTree } from './executionTreeBuilder.js';

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

test('matches repeated same-name agent calls by invocation call id', () => {
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
  assert.deepEqual(thought.children.map((node) => node.task_id), ['agent-first', 'agent-second']);
  assert.deepEqual(thought.children.map((node) => node.description), ['first task', 'second task']);
});

test('matches an existing child agent without relying on agent_name arguments', () => {
  const tree = treeWith(
    [tool('tool-resume', 'agent', { child_agent_id: 'child-1', message: 'continue task' })],
    [child('agent-resume', 'tool-resume', 'continue task')],
  );

  const [thought] = buildExecutionTree(tree);
  assert.equal(thought.children[0].type, 'agent_call');
  assert.equal(thought.children[0].task_id, 'agent-resume');
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
  assert.equal(node.type, 'agent_call');
  assert.equal(node.is_reference, true);
  assert.equal(node.participant_id, 'child-worker');
  assert.deepEqual(node.children, []);
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
