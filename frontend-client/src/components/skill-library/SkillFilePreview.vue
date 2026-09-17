<template>
  <div class="skill-file-preview min-h-0 flex-1 overflow-auto p-6">
    <template v-if="textual">
      <MarkdownContent v-if="format.category === 'markdown' && text" :content="markdownContent" />
      <FileCodeView v-else-if="text" :text="text" :language="language" />
      <div v-else class="adm-state">空文件</div>
    </template>
    <div v-else-if="imageUrl && !imageFailed" class="flex h-full items-center justify-center">
      <img :src="imageUrl" :alt="file.relative_path" class="max-h-full max-w-full object-contain" @error="imageFailed = true" />
    </div>
    <div v-else class="adm-state h-full">
      <FileText />
      <p class="adm-state__title">{{ fallbackTitle }}</p>
      <p class="adm-state__hint">可从右上角菜单下载当前文件查看。</p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watchEffect } from 'vue';
import { FileText } from 'lucide-vue-next';
import MarkdownContent from '../chat/MarkdownContent.vue';
import FileCodeView from '../files/FileCodeView.vue';
import { BINARY_PREVIEW_LIMIT, categorizeFile, correctMimeType, EXTENSION_MIME_MAP, getFileExtension } from '../files/fileCategorize.js';
import { base64EncodedSize, decodeBase64Bytes, decodeBase64Text } from '../../utils/base64.js';
import { isEditableTextFile } from '../../utils/skillFiles.js';

const props = defineProps({ file: { type: Object, required: true } });
const size = computed(() => base64EncodedSize(props.file.body_base64));
const format = computed(() => categorizeFile(props.file.relative_path, props.file.media_type?.split(';')[0].trim()));
const textual = computed(() => size.value <= 2 * 1024 * 1024 && (
  ['markdown', 'code', 'json', 'csv', 'html', 'chart'].includes(format.value.category)
  || (format.value.category === 'other' && isEditableTextFile({ ...props.file, size: size.value }))
));
// Decode only readable text. Binary files and oversized content never enter the text renderer.
const text = computed(() => textual.value ? decodeBase64Text(props.file.body_base64) : '');
const markdownContent = computed(() => text.value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''));
const language = computed(() => ['json', 'chart'].includes(format.value.category) ? 'json'
  : format.value.category === 'html' ? 'xml' : format.value.language);
const imageUrl = ref('');
const imageFailed = ref(false);
watchEffect((onCleanup) => {
  const file = props.file;
  imageUrl.value = '';
  imageFailed.value = false;
  if (format.value.category !== 'image' || size.value > BINARY_PREVIEW_LIMIT) return;
  try {
    const type = EXTENSION_MIME_MAP[getFileExtension(file.relative_path)] || correctMimeType(file.media_type, file.relative_path);
    const url = URL.createObjectURL(new Blob([decodeBase64Bytes(file.body_base64)], { type }));
    imageUrl.value = url;
    onCleanup(() => URL.revokeObjectURL(url));
  } catch {
    imageFailed.value = true;
  }
});
const fallbackTitle = computed(() => imageFailed.value ? '图片无法预览'
  : size.value > (format.value.category === 'image' ? BINARY_PREVIEW_LIMIT : 2 * 1024 * 1024) ? '文件过大，无法在线预览'
    : '此文件暂不支持预览');
</script>
