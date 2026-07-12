<template>
  <Dialog :open="open" @update:open="requestClose">
    <DialogContent class="flex h-[92vh] max-w-[1200px] flex-col overflow-hidden" :aria-describedby="undefined">
      <DialogHeader><DialogTitle>{{ fileName || 'Markdown 文件' }}<span v-if="dirty" class="ml-2 text-sm text-amber-600">未保存</span></DialogTitle></DialogHeader>
      <div class="flex items-center justify-between gap-3"><div class="flex gap-2"><button v-for="item in views" :key="item.value" class="rounded border px-3 py-1 text-sm" :class="viewMode===item.value?'bg-primary text-primary-foreground':''" @click="viewMode=item.value">{{ item.label }}</button></div><button v-if="viewMode==='edit'" class="rounded bg-primary px-3 py-1 text-sm text-primary-foreground" :disabled="saving||!dirty" @click="save">{{ saving?'保存中...':'保存' }}</button></div>
      <div v-if="loading" class="py-12 text-center text-muted-foreground">正在加载 Markdown...</div>
      <div v-else-if="error" class="py-12 text-center text-destructive">{{ error }}</div>
      <div v-else class="flex min-h-0 flex-1 flex-col">
        <MarkdownEditor v-if="viewMode==='edit'" v-model="draft" @save="save" @notify="handleNotify" />
        <ChunkWorkbench v-else-if="viewMode==='chunks'" :file-id="fileId" :markdown="markdown" :initial-char-start="initialCharStart" :initial-heading="initialHeading" @notify="handleNotify" />
        <div v-else class="knowledge-md-preview min-h-0 flex-1 overflow-auto rounded-md border p-5"><MarkdownContent :content="markdown" @notify="handleNotify" @citation-click="emit('citation-click',$event)" /></div>
      </div>
    </DialogContent>
  </Dialog>
</template>
<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'; import MarkdownContent from '../chat/MarkdownContent.vue'; import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'; import { getFileMd, updateFileMd } from '../../api/knowledgeBase.js'; import MarkdownEditor from './MarkdownEditor.vue'; import ChunkWorkbench from './ChunkWorkbench.vue';
const props=defineProps({open:Boolean,fileId:{type:String,default:''},fileName:{type:String,default:''},initialView:{type:String,default:'preview'},initialCharStart:{type:Number,default:undefined},initialHeading:{type:String,default:''}}); const emit=defineEmits(['update:open','notify','citation-click']); const views=[{value:'preview',label:'预览'},{value:'edit',label:'编辑'},{value:'chunks',label:'切片'}]; const loading=ref(false);const saving=ref(false);const markdown=ref('');const draft=ref('');const error=ref('');const viewMode=ref('preview');const dirty=computed(()=>draft.value!==markdown.value);
const handleNotify=(payload)=>emit('notify',payload); const confirmLeave=()=>!dirty.value||window.confirm('Markdown 尚未保存，确定离开吗？'); const requestClose=(value)=>{if(!value&&!confirmLeave())return;emit('update:open',value);}; const beforeUnload=(event)=>{if(!dirty.value)return;event.preventDefault();event.returnValue='';};
const load=async()=>{if(!props.open||!props.fileId)return;loading.value=true;error.value='';viewMode.value=props.initialView;try{const result=await getFileMd(props.fileId);markdown.value=result.markdown||'';draft.value=markdown.value;}catch(e){error.value=e.message||'Markdown 加载失败';}finally{loading.value=false;}};
const save=async()=>{if(!dirty.value||saving.value)return;saving.value=true;try{await updateFileMd(props.fileId,draft.value);markdown.value=draft.value;handleNotify({message:'Markdown 已保存并重新切片',type:'success'});}catch(e){handleNotify({message:e.message||'Markdown 保存失败',type:'error'});}finally{saving.value=false;}};
watch(()=>[props.open,props.fileId],load);watch(dirty,(value)=>value?window.addEventListener('beforeunload',beforeUnload):window.removeEventListener('beforeunload',beforeUnload));onBeforeUnmount(()=>window.removeEventListener('beforeunload',beforeUnload));
</script>
