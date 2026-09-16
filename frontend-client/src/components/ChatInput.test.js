import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadChatInputHelpers() {
  const filePath = new URL('./ChatInput.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');
  const clipboardMatch = source.match(/const extractClipboardFiles = \(clipboardData\) => \{([\s\S]*?)\n\};/);
  assert.ok(clipboardMatch, '应存在 extractClipboardFiles 定义');
  const dropMatch = source.match(/const extractDroppedFiles = \(dataTransfer\) => ([^\n]+);/);
  assert.ok(dropMatch, '应存在 extractDroppedFiles 定义');
  const acceptMatch = source.match(/const canAcceptDraggedFiles = \(dataTransfer\) => \{([\s\S]*?)\n\};/);
  assert.ok(acceptMatch, '应存在 canAcceptDraggedFiles 定义');
  const extractClipboardFiles = new vm.Script(`(clipboardData, File) => {${clipboardMatch[1]}\n}`).runInNewContext();
  const extractDroppedFiles = new vm.Script(`(dataTransfer, File) => ${dropMatch[1]}`).runInNewContext();
  const canAcceptDraggedFiles = new vm.Script(`(deps) => (dataTransfer) => { const { getDataTransferItems, extractDroppedFiles, hasDirectoryEntry } = deps;${acceptMatch[1]}\n}`).runInNewContext();
  return { extractClipboardFiles, extractDroppedFiles, canAcceptDraggedFiles };
}

test('extractClipboardFiles 仅提取剪贴板中的文件项', async () => {
  const { extractClipboardFiles } = await loadChatInputHelpers();

  class FakeFile {
    constructor(name) {
      this.name = name;
    }
  }

  const image = new FakeFile('screenshot.png');
  const files = extractClipboardFiles({
    items: [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => image },
      { kind: 'file', getAsFile: () => null },
    ],
  }, FakeFile);

  assert.equal(files.length, 1);
  assert.equal(files[0], image);
});

test('extractClipboardFiles 在无 clipboardData 时返回空数组', async () => {
  const { extractClipboardFiles } = await loadChatInputHelpers();

  class FakeFile {}

  const files = extractClipboardFiles(null, FakeFile);

  assert.equal(Array.isArray(files), true);
  assert.equal(files.length, 0);
});

test('extractDroppedFiles 仅提取拖拽中的文件项', async () => {
  const { extractDroppedFiles } = await loadChatInputHelpers();

  class FakeFile {
    constructor(name) {
      this.name = name;
    }
  }

  const files = extractDroppedFiles({ files: [new FakeFile('drag.png'), { foo: 'bar' }] }, FakeFile);

  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'drag.png');
});

test('canAcceptDraggedFiles 仅接受文件且拒绝目录项', async () => {
  const { canAcceptDraggedFiles } = await loadChatInputHelpers();

  class FakeFile {
    constructor(name) {
      this.name = name;
    }
  }

  const accept = canAcceptDraggedFiles({
    getDataTransferItems: (dataTransfer) => Array.from(dataTransfer?.items || []),
    extractDroppedFiles: (dataTransfer) => Array.from(dataTransfer?.files || []).filter(file => file instanceof FakeFile),
    hasDirectoryEntry: (item) => Boolean(item?.webkitGetAsEntry?.()?.isDirectory),
  });

  assert.equal(accept({
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }],
    files: [new FakeFile('ok.txt')],
  }), true);

  assert.equal(accept({
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }],
    files: [new FakeFile('folder-like')],
  }), false);

  assert.equal(accept({
    items: [{ kind: 'string' }],
    files: [],
  }), false);
});

test('拖拽遮罩通过 Teleport 挂到 body，确保真正全屏', async () => {
  const filePath = new URL('./ChatInput.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');

  assert.equal(source.includes('<Teleport to="body">'), true);
  assert.equal(source.includes('class="window-drop-overlay"'), true);
});

test('输入框底部不再渲染拖拽提示文案', async () => {
  const filePath = new URL('./ChatInput.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');

  assert.equal(source.includes('支持 Ctrl+V 粘贴截图，也可将文件拖到当前窗口'), false);
  assert.equal(source.includes('input-dropzone-hint'), false);
});

test('顶行（项目/上下文触发器）渲染在输入框之上，不占用输入框内部', async () => {
  const filePath = new URL('./ChatInput.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');
  const template = source.slice(0, source.indexOf('<script setup>'));

  const contextIndex = template.indexOf('class="composer-context"');
  const inputIndex = template.indexOf('class="input-container"');
  const shellIndex = template.indexOf('class="composer-shell"');
  assert.ok(contextIndex > -1, '应存在顶行容器 composer-context');
  assert.ok(inputIndex > contextIndex, '顶行必须排在输入框之前');
  assert.ok(shellIndex > inputIndex, '输入框应有内部 shell');

  // 输入框开头到 textarea 之前不得再嵌套顶行，否则触发器又回到框内
  assert.equal(template.slice(inputIndex, shellIndex).includes('composer-context'), false);
  assert.equal(
    source.includes("'chat-input-area--stacked': $slots.pending || $slots.context"),
    true,
  );
});

test('composer 左基准线：正文、底栏、顶行胶囊共用同一条竖线', async () => {
  const source = await readFile(new URL('./ChatInput.vue', import.meta.url), 'utf8');
  // 胶囊住在顶行槽位里，它的文字轨由「外壳内边距 + 顶行内边距 + 胶囊内边距」决定
  const pillSource = await readFile(new URL('./chat/TaskLauncher.vue', import.meta.url), 'utf8');
  const spacing = { 'var(--spacing-sm)': 8, 'var(--spacing-xs)': 4, 'var(--spacing-md)': 16 };

  const paddingInline = (css, selector) => {
    const block = css.match(selector);
    assert.ok(block, `找不到规则：${selector}`);
    const decl = block[0].match(/padding:\s*([^;]+);/);
    assert.ok(decl, `${selector} 缺少 padding 声明`);
    const parts = decl[1].trim().split(/\s+/);
    const value = parts.length === 1 ? parts[0] : parts[1];
    const px = spacing[value] ?? Number.parseFloat(value);
    assert.ok(Number.isFinite(px), `${selector} 的 padding 无法解析：${value}`);
    return px;
  };

  const container = paddingInline(source, /\.input-container \{[\s\S]*?\n\}/);
  const textarea = paddingInline(source, /\ntextarea \{[\s\S]*?\n\}/);
  const footer = paddingInline(source, /\.input-footer \{[\s\S]*?\n\}/);
  const strip = paddingInline(source, /\.composer-context,\s*\n\.composer-pending \{[\s\S]*?\n\}/);
  const pill = paddingInline(pillSource, /\.project-trigger \{[\s\S]*?\n\}/);

  const rail = container + textarea;
  // 底栏按钮的「盒子」落在正文轨上，图标墨迹再随按钮内边距内缩
  assert.equal(container + footer, rail, '底栏内边距必须与 textarea 一致');
  // 顶行本身只到外壳轨，胶囊用自己的内边距补到正文轨
  assert.equal(strip + pill, rail, '胶囊文字必须与输入框正文对齐');
});

test('发送、停止、恢复和附件能力只由显式运行时动作投影控制', async () => {
  const filePath = new URL('./ChatInput.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');

  assert.equal(source.includes('canSendWhileLoading'), false);
  assert.equal(source.includes('isLoading'), false);
  assert.equal(source.includes('const sendDisabled = computed(() => !props.canSend'), true);
  assert.equal(source.includes('v-if="canResume"'), true);
  assert.equal(source.includes('<span>继续运行</span>'), true);
  assert.equal(source.includes("if (props.canResume) {\n    emit('resume');"), true);
  assert.equal(source.includes('继续运行后再发送'), true);
  assert.equal(source.includes('v-if="canResume && canStop"'), true);
  assert.equal(source.includes('aria-label="结束挂起任务"'), true);
  assert.equal(source.includes('v-else-if="canStop && sendDisabled"'), true);
  assert.equal(source.includes(':disabled="!canAttach"'), true);
});
