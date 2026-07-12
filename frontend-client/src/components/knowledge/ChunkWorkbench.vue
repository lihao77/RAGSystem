<template>
  <div class="grid min-h-0 flex-1 grid-cols-2 gap-3">
    <div ref="markdownHost" class="overflow-auto rounded border p-4" @click="selectFromMarkdown"><MarkdownContent :content="highlightedMarkdown" @notify="emit('notify', $event)" /></div>
    <div class="overflow-auto rounded border p-3"><div v-if="loading" class="p-6 text-center">正在加载切片...</div><div v-else class="space-y-3"><article v-for="chunk in chunks" :key="chunk.id" :data-chunk-id="chunk.id" class="cursor-pointer rounded border p-3" :class="selected?.id === chunk.id ? 'border-primary bg-primary/5' : ''" @click="selectChunk(chunk)"><div class="mb-2 flex justify-between text-xs text-muted-foreground"><span>#{{ chunk.chunk_index }} {{ chunk.heading_path }}</span><button @click.stop="editing = chunk">编辑</button></div><ChunkEditor v-if="editing?.id === chunk.id" :file-id="fileId" :chunk="chunk" @cancel="editing = null" @saved="handleSaved" @notify="emit('notify', $event)" /><pre v-else class="whitespace-pre-wrap text-sm">{{ chunk.content }}</pre></article></div></div>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'; import { getFileChunks } from '../../api/knowledgeBase.js'; import MarkdownContent from '../chat/MarkdownContent.vue'; import ChunkEditor from './ChunkEditor.vue';
const props = defineProps({ fileId: String, markdown: String, initialCharStart: Number, initialHeading: String }); const emit = defineEmits(['notify']); const chunks=ref([]); const loading=ref(false); const selected=ref(null); const editing=ref(null); const markdownHost=ref(null);
const highlightedMarkdown=computed(()=>props.markdown||'');
const selectChunk=async(chunk)=>{selected.value=chunk;await nextTick();highlightChunkInDom(chunk);};
// markdown.js html:false（防 XSS），不能向 MD 源码注入 <mark>；改在渲染后 DOM 按文本匹配高亮。
const highlightChunkInDom=(chunk)=>{const host=markdownHost.value;if(!host)return;const snippet=(chunk.content||'').slice(0,40).trim();if(!snippet)return;const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(node.nodeValue.includes(snippet)){const target=node.parentElement;if(target){host.querySelectorAll('.chunk-highlight').forEach((el)=>el.classList.remove('chunk-highlight'));target.classList.add('chunk-highlight');target.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>target.classList.remove('chunk-highlight'),2500);}break;}}};
const selectFromMarkdown=(event)=>{const text=event.target?.textContent?.trim();if(!text)return;const offset=(props.markdown||'').indexOf(text.slice(0,40));const chunk=chunks.value.find(item=>offset>=item.char_start&&offset<item.char_end);if(chunk)selectChunk(chunk);};
const load=async()=>{loading.value=true;try{const result=await getFileChunks(props.fileId);chunks.value=result.data||[];const initial=chunks.value.find(c=>Number.isFinite(props.initialCharStart)&&props.initialCharStart>=c.char_start&&props.initialCharStart<c.char_end)||chunks.value.find(c=>props.initialHeading&&c.heading_path.includes(props.initialHeading));if(initial)selectChunk(initial);}catch(error){emit('notify',{message:error.message||'切片加载失败',type:'error'});}finally{loading.value=false;}};
const handleSaved=(updated)=>{const index=chunks.value.findIndex(c=>c.id===updated.id);if(index>=0)chunks.value[index]={...chunks.value[index],content:updated.content,manual:true};editing.value=null;emit('notify',{message:'切片已保存并重嵌入',type:'success'});};
onMounted(load);watch(()=>props.fileId,load);
</script>
<style scoped>
.chunk-highlight { background: color-mix(in srgb, var(--color-accent, #3aa675) 18%, transparent); transition: background .4s; border-radius: 2px; }
</style>
