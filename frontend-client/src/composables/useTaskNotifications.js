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

export function useTaskNotifications() {
  return {
    parseTaskNotifications,
  };
}
