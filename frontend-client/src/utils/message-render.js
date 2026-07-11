const VIZ_PLACEHOLDER_RE = /\[viz:(viz_\w+)\]/g;

const executionTreeHasContent = (executionTree) => Boolean(executionTree?.root);

const getMessageExecutionTime = (msg) => {
  const value = msg?.metadata?.execution_time;
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const getMessageFirstTokenTime = (msg) => {
  const value = msg?.metadata?.first_token_time;
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const formatExecutionTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`;
};

const formatPreciseExecutionTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(3)}s`;
};

export function hasExecutionContent(msg) {
  if (!msg || msg.role !== 'assistant') return false;
  return Boolean(msg.has_execution) || executionTreeHasContent(msg.executionTree);
}

export function getMessageExecutionTimeText(msg) {
  const seconds = getMessageExecutionTime(msg);
  return seconds == null ? '' : `响应时间 ${formatExecutionTime(seconds)}`;
}

export function getMessageExecutionTimeTitle(msg) {
  const executionTime = getMessageExecutionTime(msg);
  if (executionTime == null) return '';
  const lines = [`Run 执行时间：${formatPreciseExecutionTime(executionTime)}`];
  const firstTokenTime = getMessageFirstTokenTime(msg);
  if (firstTokenTime != null) {
    lines.push(`首 token：${formatPreciseExecutionTime(firstTokenTime)}`);
  }
  return lines.join('\n');
}

export function parseTaskNotificationContent(content) {
  const items = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let match;

  while ((match = re.exec(content || '')) !== null) {
    const xml = match[1];
    const get = (tag) => {
      const tagMatch = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
      return tagMatch ? tagMatch[1] : '';
    };

    items.push({
      taskId: get('task-id') || 'unknown',
      status: get('status') || 'completed',
      resultType: get('result-type') || '',
    });
  }

  return items.length ? items : [{ taskId: 'unknown', status: 'completed', resultType: '' }];
}

export function parseTaskNotifications(msg) {
  if (msg._notifications?.length) return msg._notifications;
  return parseTaskNotificationContent(msg.content);
}

export function parseMessageParts(msg) {
  const content = msg?.content || '';
  const hasViz = VIZ_PLACEHOLDER_RE.test(content);
  VIZ_PLACEHOLDER_RE.lastIndex = 0;

  if (!hasViz) return [{ type: 'text', content }];

  const parts = [];
  let lastIndex = 0;
  let match;
  while ((match = VIZ_PLACEHOLDER_RE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'viz', artifactId: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', content: content.slice(lastIndex) });
  }
  return parts;
}
