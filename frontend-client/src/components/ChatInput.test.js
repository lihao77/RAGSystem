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
