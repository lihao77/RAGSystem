// 参与者(participant)视觉映射 —— 侧栏 / 执行树 / 运行中心共用一份。
// root 用全局 accent;子 agent 按稳定哈希轮转语义色,保证同一 agent 三处同色。
const CHILD_PALETTE = ['violet', 'blue', 'green', 'cyan', 'orange', 'pink'];

const hashString = (value) => {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
};

// 返回该 participant 对应的 CSS 变量名(不含 var()),root 归 accent。
export function participantAccentVar(participant) {
  if (!participant || participant.scope === 'root' || participant.participant_id === 'root') {
    return '--color-brand-accent';
  }
  const key = participant.participant_id || participant.agent_name || '';
  const tone = CHILD_PALETTE[hashString(key) % CHILD_PALETTE.length];
  return `--color-agent-${tone}`;
}

// 解析为可直接用于 style 的颜色值(var() 引用,随主题切换)。
export function participantAccentColor(participant) {
  return `var(${participantAccentVar(participant)})`;
}

// 执行树 agent 节点 → 语义色;与侧栏同一 agent 同色。
// 优先 participant_id(与侧栏哈希同源),退到 agent_name。
export function agentNodeAccentColor(node) {
  if (!node) return 'var(--color-text-muted)';
  return participantAccentColor({
    scope: node.scope,
    participant_id: node.participant_id,
    agent_name: node.agent_name,
  });
}

// 状态 → 语义色变量(用于状态点着色);未知/就绪归 muted。
export function statusToneColor(status) {
  const tone = {
    running: '--color-brand-accent',
    active: '--color-brand-accent',
    suspended: '--color-warning',
    pending: '--color-text-muted',
    failed: '--color-error',
    interrupted: '--color-error',
    blocked: '--color-error',
    completed: '--color-success',
    succeeded: '--color-success',
    cancelled: '--color-text-muted',
  }[status];
  return `var(${tone || '--color-text-muted'})`;
}

// 状态 → 中文标签(Tooltip / aria 用)。
export function statusLabel(status) {
  return {
    running: '运行中',
    suspended: '等待中',
    completed: '已完成',
    succeeded: '已完成',
    failed: '失败',
    interrupted: '已中断',
    active: '就绪',
    cancelled: '已取消',
    blocked: '已阻塞',
    pending: '待执行',
  }[status] || status || '就绪';
}
