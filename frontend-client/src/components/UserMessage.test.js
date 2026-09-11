import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('用户气泡正文超高折叠：钳高由 useClampedExpand 驱动，悬浮图标按钮随需出现', async () => {
  const source = await readFile(new URL('./chat/UserMessage.vue', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../styles/chat-view.css', import.meta.url), 'utf8');

  // 正文气泡（普通用户消息 / 智能体消息 / followup 共用同一 .user-text 元素）接入折叠，
  // 钳高约 4.5 行正文。
  assert.equal(source.includes(`ref="userTextEl"`), true);
  assert.equal(source.includes(`'is-clampable': textClampable`), true);
  assert.equal(source.includes(`'is-clamped': textClampable && !textExpanded`), true);
  assert.equal(source.includes('useClampedExpand(userTextEl, { clamp: 120 })'), true);
  // 折叠按钮是纯图标胶囊，渲染在气泡内部（插值紧贴开标签，pre-wrap 不引入尾随空白），
  // 无文字标签、用 aria-label 交代动作。
  assert.equal(source.includes('>{{ displayText }}<button'), true);
  assert.equal(source.includes(`v-if="textClampable"`), true);
  assert.equal(source.includes(`:aria-label="textExpanded ? '收起' : '展开'"`), true);
  assert.equal(source.includes(`{{ textExpanded ? '收起' : '展开' }}`), false);

  // is-clampable 常驻裁剪（含展开过渡期），is-clamped 叠加底部渐隐。
  assert.equal(styles.includes('.user-text.is-clampable,'), true);
  assert.equal(styles.includes('.user-text.is-clamped::after'), true);
  // 渐隐色跟随气泡背景：默认气泡与智能体消息变体各自对色。
  assert.equal(styles.includes('linear-gradient(to bottom, transparent, var(--color-bg-message-user))'), true);
  assert.equal(styles.includes('.message.user.message--agent-message .user-text.is-clampable::after'), true);
  // 悬浮胶囊：绝对定位在气泡内底部居中，底色由气泡色向页面色混一小步，
  // 智能体消息与玻璃通知卡各有跟随其气泡底色的混色基准。
  assert.equal(styles.includes('color-mix(in srgb, var(--color-bg-primary) 30%, var(--color-bg-message-user))'), true);
  assert.equal(styles.includes('.message.user.message--agent-message .bubble-clamp-toggle'), true);
  assert.equal(styles.includes('.task-notification-body .bubble-clamp-toggle'), true);
  assert.equal(styles.includes('.is-clampable:not(.is-clamped) > .bubble-clamp-toggle'), true);
});

test('后台通知列表超高折叠：通知条目过多时钳住列表体，同一悬浮按钮交互', async () => {
  const source = await readFile(new URL('./chat/UserMessage.vue', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../styles/chat-view.css', import.meta.url), 'utf8');

  // 通知列表（非头部）接折叠，条目复用 computed 避免模板里重复解析。
  assert.equal(source.includes(`ref="notificationBodyEl"`), true);
  assert.equal(source.includes(`'is-clamped': notificationClampable && !notificationExpanded`), true);
  assert.equal(source.includes('useClampedExpand(notificationBodyEl, { clamp: 132 })'), true);
  assert.equal(source.includes('parseTaskNotifications(props.msg)'), true);
  assert.equal(source.includes(`:aria-label="notificationExpanded ? '收起通知列表' : '展开全部通知'"`), true);
  // goal 自动续跑块是固定单行，不接折叠。
  const goalBlock = source.slice(source.indexOf("goal_continuation'"), source.indexOf('user-bubble-wrapper'));
  assert.equal(goalBlock.includes('useClampedExpand'), false);

  // 通知块渐隐到玻璃底色；按钮与用户气泡共用同一胶囊样式。
  assert.equal(styles.includes('.task-notification-body.is-clampable::after'), true);
  assert.equal(styles.includes('linear-gradient(to bottom, transparent, var(--glass-bg,'), true);
  assert.equal(styles.includes('bubble-clamp-toggle--block'), false);
});
