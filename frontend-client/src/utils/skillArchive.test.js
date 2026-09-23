import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import { decodeBase64Bytes, encodeBase64Bytes } from './base64.js';
import { createSkillZip, decodeZipFileName, isIgnoredArchivePath, parseSkillFrontmatter, readFolderBundle, readZipBundle } from './skillArchive.js';

const skillMd = (name = 'demo-skill', description = '演示技能') => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n使用说明。\n`;
const BINARY = new Uint8Array([0, 1, 2, 255]);

async function zipBuffer(entries) {
  const zip = new JSZip();
  for (const [path, content] of entries) zip.file(path, content);
  return (await zip.generateAsync({ type: 'uint8array' })).buffer;
}

function fakeFile(path, content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return { name: path.split('/').pop(), webkitRelativePath: path, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

function bytesOf(base64) {
  return Array.from(decodeBase64Bytes(base64));
}

test('parseSkillFrontmatter extracts quoted and plain scalars plus content', () => {
  assert.deepEqual(parseSkillFrontmatter(skillMd('demo-skill', '描述')), { name: 'demo-skill', description: '描述', content: '使用说明。\n' });
  assert.deepEqual(parseSkillFrontmatter(`---\nname: a-b\ndescription: '单引号'\n---\n正文`), { name: 'a-b', description: '单引号', content: '正文' });
  assert.deepEqual(parseSkillFrontmatter('没有 frontmatter'), { name: '', description: '', content: '没有 frontmatter' });
  assert.deepEqual(parseSkillFrontmatter('---\nname: only-name\n---\nx'), { name: 'only-name', description: '', content: 'x' });
});

test('isIgnoredArchivePath matches OS junk and reserved segments case-insensitively', () => {
  assert.equal(isIgnoredArchivePath('__MACOSX/SKILL.md'), true);
  assert.equal(isIgnoredArchivePath('scripts/__pycache__/c.pyc'), true);
  assert.equal(isIgnoredArchivePath('.DS_Store'), true);
  assert.equal(isIgnoredArchivePath('scripts/run.py'), false);
});

test('decodeZipFileName falls back to GBK for ANSI zip filenames', () => {
  assert.equal(decodeZipFileName(new Uint8Array([0x2e, 0x74, 0x78, 0x74])), '.txt');
  assert.equal(decodeZipFileName(new TextEncoder().encode('说明.md')), '说明.md');
  assert.equal(decodeZipFileName(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), '中文');
  // 双重失效（既非 UTF-8 也非 GBK）的字节不抛异常，返回空串会在路径校验处被拒。
  assert.equal(typeof decodeZipFileName(new Uint8Array([0xff])), 'string');
});

test('readZipBundle imports a flat skill with SKILL.md first and stable ordering', async () => {
  const bundle = await readZipBundle(await zipBuffer([
    ['scripts/run.py', 'print(1)'],
    ['SKILL.md', skillMd()],
    ['agents/reviewer.md', '角色'],
  ]));
  assert.equal(bundle.name, 'demo-skill');
  assert.equal(bundle.description, '演示技能');
  assert.deepEqual(bundle.files.map((file) => file.relative_path), ['SKILL.md', 'agents/reviewer.md', 'scripts/run.py']);
  assert.equal(bundle.files[0].media_type, 'text/markdown; charset=utf-8');
});

test('readZipBundle strips one wrapper directory and filters junk, reserved dirs and manifest', async () => {
  const bundle = await readZipBundle(await zipBuffer([
    ['demo-skill/SKILL.md', skillMd()],
    ['demo-skill/scripts/run.py', 'print(1)'],
    ['demo-skill/manifest.json', '{"ignored": true}'],
    ['demo-skill/node_modules/pkg/index.js', 'junk'],
    ['__MACOSX/demo-skill/SKILL.md', 'junk'],
    ['demo-skill/.DS_Store', 'junk'],
  ]));
  assert.deepEqual(bundle.files.map((file) => file.relative_path), ['SKILL.md', 'scripts/run.py']);
});

test('readZipBundle decodes GBK-named entries from Windows-style zips', async () => {
  const zip = buildStoredZip([
    { nameBytes: new TextEncoder().encode('SKILL.md'), data: new TextEncoder().encode(skillMd()) },
    // 「中文名.md」的 GBK 字节（D6 D0 CE C4 C3 FB），未置 UTF-8 标志位
    { nameBytes: new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xc3, 0xfb, 0x2e, 0x6d, 0x64]), data: new TextEncoder().encode('# 附注') },
  ]);
  const bundle = await readZipBundle(concat(zip).buffer);
  assert.deepEqual(bundle.files.map((file) => file.relative_path), ['SKILL.md', '中文名.md']);
});

test('readZipBundle rejects archives without a root SKILL.md or with invalid frontmatter', async () => {
  await assert.rejects(readZipBundle(await zipBuffer([['docs/readme.md', 'x']])), /缺少根 SKILL\.md/);
  await assert.rejects(readZipBundle(await zipBuffer([['SKILL.md', '---\nname: Bad Name\ndescription: d\n---\nx']])), /name/);
  await assert.rejects(readZipBundle(await zipBuffer([['SKILL.md', '---\nname: demo-skill\n---\nx']])), /description/);
});

test('readZipBundle enforces pre-save parity with the backend validator', async () => {
  await assert.rejects(readZipBundle(await zipBuffer([
    ['SKILL.md', skillMd()], ['scripts/run.py', 'a'], ['Scripts/Run.PY', 'b'],
  ])), /重复文件/);
  await assert.rejects(readZipBundle(await zipBuffer([
    ['SKILL.md', skillMd()], ['scripts', 'file'], ['scripts/run.py', 'a'],
  ])), /目录冲突/);
  await assert.rejects(readZipBundle(await zipBuffer([
    ['SKILL.md', skillMd()], ['con.txt', 'x'],
  ])), /无效文件路径/);
  await assert.rejects(readZipBundle(await zipBuffer([['SKILL.md', `---\nname: demo-skill\ndescription: d\n---\n`]])), /正文为空/);
  await assert.rejects(readZipBundle(await zipBuffer([['SKILL.md', `---\nname: demo-skill\ndescription: d\n---\n${'x'.repeat(30001)}`]])), /30000/);
});

test('readZipBundle enforces the empty-archive and file-count limits', async () => {
  await assert.rejects(readZipBundle(await zipBuffer([])), /导入内容为空/);
  const entries = [['SKILL.md', skillMd()]];
  for (let index = 0; index < 256; index += 1) entries.push([`scripts/f${index}.py`, 'x']);
  await assert.rejects(readZipBundle(await zipBuffer(entries)), /文件数量超过/);
});

test('readFolderBundle reads webkitRelativePath and strips the selected folder name', async () => {
  const bundle = await readFolderBundle([
    fakeFile('my-skill/SKILL.md', skillMd('folder-skill', '来自文件夹')),
    fakeFile('my-skill/assets/icon.png', BINARY),
    fakeFile('my-skill/.git/config', 'junk'),
  ]);
  assert.equal(bundle.name, 'folder-skill');
  assert.deepEqual(bundle.files.map((file) => file.relative_path), ['SKILL.md', 'assets/icon.png']);
  assert.deepEqual(bytesOf(bundle.files.find((file) => file.relative_path === 'assets/icon.png').body_base64), Array.from(BINARY));
});

test('readFolderBundle pre-checks size and count before reading files', async () => {
  const big = { size: 30 * 1024 * 1024, webkitRelativePath: 'a/big1.bin', name: 'big1.bin', arrayBuffer: async () => { throw new Error('should not read'); } };
  const big2 = { ...big, name: 'big2.bin', webkitRelativePath: 'a/big2.bin' };
  await assert.rejects(readFolderBundle([
    fakeFile('a/SKILL.md', skillMd()), big, big2,
  ]), /50MB/);
});

test('createSkillZip output round-trips through readZipBundle, binary intact', async () => {
  const files = [
    { relative_path: 'SKILL.md', body_base64: encodeBase64Bytes(new TextEncoder().encode(skillMd())) },
    { relative_path: 'assets/icon.png', body_base64: encodeBase64Bytes(BINARY) },
  ];
  const blob = await createSkillZip(files);
  const bundle = await readZipBundle(await blob.arrayBuffer());
  assert.equal(bundle.name, 'demo-skill');
  assert.deepEqual(bundle.files.map((file) => file.relative_path), ['SKILL.md', 'assets/icon.png']);
  assert.deepEqual(bytesOf(bundle.files.find((file) => file.relative_path === 'assets/icon.png').body_base64), Array.from(BINARY));
});

/** 手工构造 STORE 型 zip（无 UTF-8 标志位），用于复现 Windows ANSI 压缩包的文件名字节。 */
function buildStoredZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { nameBytes, data } of entries) {
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0, true); lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    const dir = new Uint8Array(46 + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint32(16, crc, true); dv.setUint32(20, data.length, true); dv.setUint32(24, data.length, true);
    dv.setUint16(28, nameBytes.length, true); dv.setUint32(42, offset, true);
    dir.set(nameBytes, 46);
    central.push(dir);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((sum, dir) => sum + dir.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return [...chunks, ...central, eocd];
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}
