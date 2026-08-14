<!-- eslint-disable vue/no-mutating-props -- form/input_values 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="open" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[860px]">
      <DialogHeader>
        <DialogTitle class="sr-only">配置安装</DialogTitle>
        <div class="modal-title-block">
          <h3>配置安装</h3>
          <p>{{ server?.display_name || server?.name }}</p>
        </div>
      </DialogHeader>
      <div class="adm-modal-form">
        <div class="form-grid">
          <label class="field">
            <span>安装方式</span>
            <CustomSelect :model-value="form.option_id" :options="[{ value: '', label: '请选择安装方式' }, ...(server?.install_options || []).map(o => ({ value: o.id, label: o.supported ? o.label : `${o.label}（暂不支持）`, disabled: !o.supported }))]" placeholder="请选择安装方式" @update:model-value="form.option_id = $event; emit('optionChange', $event)" />
            <small v-if="selectedOption?.command_preview">命令：{{ selectedOption.command_preview }}</small>
            <small v-if="selectedOption?.url_preview">地址：{{ selectedOption.url_preview }}</small>
            <small v-if="selectedOption?.unsupported_reason" class="text-warning">{{ selectedOption.unsupported_reason }}</small>
          </label>
        </div>
        <div class="form-grid">
          <label class="field"><span>服务名称</span><Input v-model.trim="form.server_name" type="text" placeholder="本地唯一标识" /></label>
          <label class="field"><span>显示名称</span><Input v-model.trim="form.display_name" type="text" placeholder="页面展示名称" /></label>
        </div>
        <div v-if="fields.length" class="form-grid">
          <label v-for="field in fields" :key="field.key" class="field">
            <span>{{ field.label }}<em v-if="field.required">*</em></span>
            <CustomSelect v-if="field.format === 'select'" :model-value="form.input_values[field.key]" :options="field.options || []" :placeholder="field.placeholder || ''" @update:model-value="form.input_values[field.key] = $event" />
            <Textarea v-else-if="field.format === 'textarea'" v-model="form.input_values[field.key]" rows="4" class="font-mono-input" :placeholder="field.placeholder || ''" />
            <Input v-else-if="field.format !== 'boolean'" v-model="form.input_values[field.key]" :type="field.secret ? 'password' : field.format === 'number' ? 'number' : 'text'" :placeholder="field.placeholder || ''" />
            <label v-else class="toggle-field toggle-field--inner"><Switch v-model:checked="form.input_values[field.key]" /><span>启用</span></label>
            <small v-if="field.description">{{ field.description }}</small>
            <small v-if="field.repeated">多值请用英文逗号分隔</small>
          </label>
        </div>
        <div class="form-divider"></div>
        <div class="form-grid">
          <label class="field"><span>超时秒数</span><NumberInput :model-value="form.timeout" :min="1" :max="300" @update:model-value="form.timeout = $event" /></label>
          <label class="field"><span>风险等级</span><CustomSelect :model-value="form.risk_level" :options="riskOptions" @update:model-value="form.risk_level = $event" /></label>
        </div>
        <div class="toggle-row">
          <label class="toggle-field"><Switch v-model:checked="form.enabled" /><span>启用服务</span></label>
          <label class="toggle-field"><Switch v-model:checked="form.auto_connect" /><span>自动连接</span></label>
        </div>
      </div>
      <DialogFooter>
        <Button size="sm" @click="emit('close')">取消</Button>
        <Button size="sm" variant="default" :disabled="installing || !selectedOption?.supported" @click="emit('submit')">{{ installing ? '安装中...' : '安装服务' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// MCP Registry「配置安装」弹窗。
import CustomSelect from '../ui/CustomSelect.vue';
import NumberInput from '../NumberInput.vue';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';
import { Textarea } from '../ui/textarea';

defineProps({
  open: { type: Boolean, default: false },
  server: { type: Object, default: null },
  form: { type: Object, required: true },
  selectedOption: { type: Object, default: null },
  fields: { type: Array, default: () => [] },
  riskOptions: { type: Array, default: () => [] },
  installing: { type: Boolean, default: false },
});

const emit = defineEmits(['close', 'submit', 'optionChange']);
</script>
