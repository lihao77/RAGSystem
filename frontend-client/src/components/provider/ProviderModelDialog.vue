<!-- eslint-disable vue/no-mutating-props -- modelForm 为视图持有的 reactive 表单对象，弹窗内改写属有意的表单模型架构 -->
<template>
  <Dialog :open="dialog.visible" @update:open="(v) => { if (!v) emit('close') }">
    <DialogContent class="max-w-[520px] z-[60]">
      <DialogHeader>
        <DialogTitle>{{ dialog.mode === 'create' ? '添加模型' : '编辑模型' }}</DialogTitle>
        <DialogDescription>配置模型级运行参数与能力位；同一 Provider 下模型名不可重复。</DialogDescription>
      </DialogHeader>
      <div class="dialog-form">
        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>模型</h3><p>模型名即调用 API 时的 model 参数。</p></div>
          <FieldGroup class="form-grid">
            <Field class="form-grid__full" :data-invalid="!!formErrors.name">
              <FieldLabel for="provider-model-name">模型名 <span class="required">*</span></FieldLabel>
              <Input id="provider-model-name" v-model="form.name" :aria-invalid="!!formErrors.name" placeholder="例如：gpt-4.1 / glm-4.7" />
              <FieldError v-if="formErrors.name">{{ formErrors.name }}</FieldError>
            </Field>
          </FieldGroup>
        </section>

        <section class="dialog-form-section">
          <div class="dialog-form-section__head"><h3>运行参数</h3><p>模型级参数随模型生效；清空则调用时不指定，使用服务端默认值。</p></div>
          <FieldGroup class="form-grid">
            <Field><FieldLabel for="provider-model-temperature">温度</FieldLabel><Input id="provider-model-temperature" v-model.number="form.temperature" type="number" step="0.1" min="0" max="2" placeholder="0.7" /></Field>
            <Field><FieldLabel for="provider-model-completion-tokens">Max Completion Tokens</FieldLabel><Input id="provider-model-completion-tokens" v-model.number="form.max_completion_tokens" type="number" step="256" min="256" placeholder="4096" /></Field>
            <Field><FieldLabel for="provider-model-context-tokens">Max Context Tokens</FieldLabel><Input id="provider-model-context-tokens" v-model.number="form.max_context_tokens" type="number" step="1024" min="1024" placeholder="128000" /></Field>
          </FieldGroup>
          <FieldSet>
            <FieldLegend variant="label">模型能力</FieldLegend>
            <FieldGroup class="capability-fields">
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_function_calling" />
                  <FieldContent><FieldTitle>原生 Function Calling</FieldTitle><FieldDescription>OpenAI 兼容模型启用厂商原生工具调用；Anthropic 自动使用 tool_use。</FieldDescription></FieldContent>
                </FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <FieldLabel>
                  <Switch v-model:checked="form.supports_vision" />
                  <FieldContent><FieldTitle>图片输入（Vision）</FieldTitle><FieldDescription>标记该模型能够在对话中识别图片。</FieldDescription></FieldContent>
                </FieldLabel>
              </Field>
            </FieldGroup>
          </FieldSet>
        </section>

        <FieldError v-if="dialog.error">{{ dialog.error }}</FieldError>
      </div>
      <DialogFooter class="provider-dialog-footer">
        <Button size="sm" variant="outline" @click="emit('close')">取消</Button>
        <Button class="provider-dialog-submit" size="sm" variant="default" @click="emit('submit')">{{ dialog.mode === 'create' ? '添加' : '保存' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup>
// 模型条目新增/编辑弹窗：模型名 + 模型级运行参数与能力位（挂在模型上，Provider 只管连接）。
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  Field, FieldContent, FieldDescription, FieldError, FieldGroup,
  FieldLabel, FieldLegend, FieldSet, FieldTitle,
} from '../ui/field';
import { Input } from '../ui/input';
import { Switch } from '../ui/switch';

defineProps({
  dialog: { type: Object, required: true },
  form: { type: Object, required: true },
  formErrors: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['close', 'submit']);
</script>
