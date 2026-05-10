export function parseTaskNotifications(msg) {
  if (msg._notifications?.length) return msg._notifications;

  const content = msg.content || '';
  const items = [];
  const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
  let match;

  while ((match = re.exec(content)) !== null) {
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

export function buildTaskNotificationMessage(sessionId, event) {
  const notifications = Array.isArray(event?.data?.notifications) ? event.data.notifications : [];
  const runId = event?.run_id || event?.data?.run_id || null;
  const content = notifications.map((item) => {
    const taskId = item.background_task_id || item.task_id || 'unknown';
    const outputPath = item.output_path || '';
    const status = item.status || 'completed';
    const returnCode = item.return_code;
    const resultType = item.result_type || '';
    const parts = ['<task-notification>'];

    parts.push(`<task-id>${taskId}</task-id>`);
    if (outputPath) parts.push(`<output-file>${outputPath}</output-file>`);
    parts.push(`<status>${status}</status>`);
    if (returnCode != null) parts.push(`<return-code>${returnCode}</return-code>`);
    if (resultType) parts.push(`<result-type>${resultType}</result-type>`);
    parts.push('</task-notification>');

    return parts.join('\n');
  }).join('\n\n');

  return {
    role: 'user',
    content,
    metadata: {
      source: 'system.bg_notification',
      run_id: runId,
    },
    _notifications: notifications.map((item) => ({
      taskId: item.background_task_id || item.task_id || 'unknown',
      status: item.status || 'completed',
      resultType: item.result_type || '',
    })),
    _bgRunId: runId,
    _bgSessionId: sessionId,
  };
}

export function useTaskNotifications() {
  return {
    parseTaskNotifications,
    buildTaskNotificationMessage,
  };
}
