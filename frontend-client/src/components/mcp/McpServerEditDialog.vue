<!-- eslint-disable vue/no-mutating-props -- form 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog v-if="form" :open="open" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[860px]">
      <DialogHeader>
        <DialogTitle class="sr-only">编辑 MCP 服务</DialogTitle>
        <div class="modal-title-block">
          <h3>编辑 MCP 服务</h3>
          <p class="font-mono">{{ form.name }}</p>
        </div>
      </DialogHeader>
      <div class="adm-modal-form">
        <div class="form-grid">
          <label class="field"><span>显示名称</span><Input v-model="form.display_name" type="text" /></label>
          <div class="field"><span>传输方式</span><CustomSelect :model-value="form.transport" :options="transportOptions" @update:model-value="form.transport = $event" /></div>
        </div>
        <div v-if="form.transport === 'stdio'" class="form-grid">
          <label class="field"><span>命令</span><Input v-model="form.command" type="text" placeholder="如 npx / node / python" /></label>
          <label class="field"><span>参数列表 (JSON Array)</span><Textarea v-model="form.argsJson" rows="4" class="font-mono-input"></Textarea></label>
          <label class="field"><span>环境变量 (JSON Object)</span><Textarea v-model="form.envJson" rows="4" class="font-mono-input"></Textarea></label>
        </div>
        <div v-else class="form-grid">
          <label class="field"><span>URL</span><Input v-model="form.url" type="url" placeholder="http://localhost:8080/mcp" /></label>
          <label class="field"><span>Headers (JSON Object)</span><Textarea v-model="form.headersJson" rows="4" class="font-mono-input"></Textarea></label>
        </div>
        <div class="form-divider"></div>
        <div class="form-grid">
          <div class="field"><span>超时秒数</span><NumberInput :model-value="form.timeout" :min="1" :max="300" @update:model-value="form.timeout = $event" /></div>
          <div class="field"><span>风险等级</span><CustomSelect :model-value="form.risk_level" :options="riskOptions" @update:model-value="form.risk_level = $event" /></div>
        </div>
        <p class="form-hint">工具级风险覆盖:连接后在「工具」列表里按工具单独调整。</p>
        <div class="toggle-row">
          <label class="toggle-field"><Switch v-model:checked="form.enabled" /><span>启用服务</span></label>
          <label class="toggle-field"><Switch v-model:checked="form.auto_connect" /><span>自动连接</span></label>
          <label class="toggle-field"><Switch v-model:checked="form.trusted" /><span>受信任</span></label>
        </div>
      </div>
      <DialogFooter>
        <Button size="sm" @click="emit('close')">取消</Button>
        <Button size="sm" variant="default" :disabled="saving" @click="emit('submit')">{{ saving ? '保存中...' : '保存更改' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// MCP 服务编辑弹窗。
import CustomSelect from '../ui/CustomSelect.vue';
import NumberInput from '../NumberInput.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';

defineProps({
  open: { type: Boolean, default: false },
  form: { type: Object, default: null },
  transportOptions: { type: Array, default: () => [] },
  riskOptions: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'submit']);
</script>
