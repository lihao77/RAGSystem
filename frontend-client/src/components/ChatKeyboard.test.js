import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { compile } from 'vue';

async function loadKeyboard(component, overrides = {}) {
  const source = await readFile(new URL(`./${component}.vue`, import.meta.url), 'utf8');
  const textarea = source.match(/<textarea\b[^>]*>/)?.[0];
  assert.ok(textarea, '应存在消息文本框');
  // 编译实际模板中的键盘绑定，覆盖 .prevent 抢先吞掉 Shift+Enter 的回归。
  const bindings = textarea.match(/@keydown[^\s=]*="[^"]*"/g) || [];
  const enter = source.match(/const handleEnter = \(event\) => \{[\s\S]*?\n\};/);
  assert.ok(enter, '应存在 handleEnter 定义');
  const send = source.match(/const handleSend = \(\) => \{[\s\S]*?\n\};/);
  const events = [];
  const emit = (...args) => events.push(args);
  const inputText = { value: '第一行\n第二行' };
  const handleEnter = new vm.Script(`${send?.[0] || ''}\n${enter[0]}\nhandleEnter`).runInNewContext({
    props: { canSend: true, canResume: false, attachments: [], submitting: false, ...overrides },
    emit,
    inputText,
    textareaRef: { value: null },
  });
  const vnode = compile(`<textarea ${bindings.join(' ')} />`)({ handleEnter, $emit: emit }, []);
  const press = (overrides = {}) => {
    const event = {
      key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false,
      isComposing: false, keyCode: 13, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...overrides,
    };
    const listeners = [vnode.props.onKeydown].flat();
    for (const listener of listeners) listener(event);
    return event;
  };
  return { press, events, inputText };
}

for (const component of ['ChatInput', 'MessageEditBox']) {
  test(`${component}: Shift+Enter 保留原生换行且不提交`, async () => {
    const { press, events, inputText } = await loadKeyboard(component);
    assert.equal(press({ shiftKey: true }).defaultPrevented, false);
    assert.equal(events.length, 0);
    assert.equal(inputText.value, '第一行\n第二行');
  });

  test(`${component}: Enter 仅提交一次并阻止插入换行`, async () => {
    const { press, events, inputText } = await loadKeyboard(component);
    assert.equal(press().defaultPrevented, true);
    assert.equal(events.length, 1);
    assert.equal(events[0][0], component === 'ChatInput' ? 'send' : 'confirm');
    if (component === 'ChatInput') {
      assert.equal(events[0][1].content, '第一行\n第二行');
      assert.equal(inputText.value, '');
    }
  });

  test(`${component}: 输入法选词回车不提交或阻止默认行为`, async () => {
    const { press, events } = await loadKeyboard(component);
    assert.equal(press({ isComposing: true }).defaultPrevented, false);
    assert.equal(press({ keyCode: 229 }).defaultPrevented, false);
    assert.equal(events.length, 0);
  });
}

test('ChatInput: 挂起时 Shift+Enter 换行，Enter 恢复运行', async () => {
  const { press, events } = await loadKeyboard('ChatInput', { canResume: true });
  assert.equal(press({ shiftKey: true }).defaultPrevented, false);
  assert.equal(events.length, 0);
  assert.equal(press().defaultPrevented, true);
  assert.deepEqual(events, [['resume']]);
});

test('ChatInput: 禁止发送时 Enter 不发送或插入换行', async () => {
  const { press, events, inputText } = await loadKeyboard('ChatInput', { canSend: false });
  assert.equal(press().defaultPrevented, true);
  assert.equal(events.length, 0);
  assert.equal(inputText.value, '第一行\n第二行');
});

test('MessageEditBox: 提交中 Enter 不重复提交', async () => {
  const { press, events } = await loadKeyboard('MessageEditBox', { submitting: true });
  assert.equal(press().defaultPrevented, true);
  assert.equal(events.length, 0);
});

test('MessageEditBox: Esc 取消，Ctrl/Cmd+Enter 仍可提交', async () => {
  const { press, events } = await loadKeyboard('MessageEditBox');
  assert.equal(press({ key: 'Escape', keyCode: 27 }).defaultPrevented, true);
  assert.equal(press({ ctrlKey: true }).defaultPrevented, true);
  assert.equal(press({ metaKey: true }).defaultPrevented, true);
  assert.deepEqual(events, [['cancel'], ['confirm'], ['confirm']]);
});
