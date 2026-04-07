const AGENT_BADGE_CLASSES = [
  'agent-violet',
  'agent-blue',
  'agent-green',
  'agent-cyan',
  'agent-orange',
  'agent-pink'
];

export function getAgentBadgeClass(agentName) {
  if (!agentName) return 'default';

  const normalized = String(agentName).trim().toLowerCase();
  if (!normalized) return 'default';

  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
    hash |= 0;
  }

  return AGENT_BADGE_CLASSES[Math.abs(hash) % AGENT_BADGE_CLASSES.length];
}
