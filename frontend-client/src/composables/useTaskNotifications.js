/**
 * 解析 <task-notification> XML 内容为结构化条目(纯函数,无副作用)。
 * parseTaskNotifications(msg) 与 executionTreeBuilder 的 injection 节点共用,避免重复解析逻辑。
 */
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

export function useTaskNotifications() {
  return {
    parseTaskNotifications,
  };
}
