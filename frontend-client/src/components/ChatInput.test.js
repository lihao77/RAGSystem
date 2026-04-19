import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function loadChatInputHelpers() {
  const filePath = new URL('./ChatInput.vue', import.meta.url);
  const source = await readFile(filePath, 'utf8');
  const match = source.match(/const extractClipboardFiles = \(clipboardData\) => \{([\s\S]*?)\n\};/);
  assert.ok(match, '应存在 extractClipboardFiles 定义');
  const script = new vm.Script(`(clipboardData, File) => {${match[1]}\n}`);
  return script.runInNewContext();
}

test('extractClipboardFiles 仅提取剪贴板中的文件项', async () => {
  const extractClipboardFiles = await loadChatInputHelpers();

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
  const extractClipboardFiles = await loadChatInputHelpers();

  class FakeFile {}

  const files = extractClipboardFiles(null, FakeFile);

  assert.equal(Array.isArray(files), true);
  assert.equal(files.length, 0);
});
