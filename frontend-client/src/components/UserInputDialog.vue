<template>
  <Teleport to="body">
    <Transition name="overlay-fade">
      <div v-if="visible" class="input-overlay" @click="handleOverlayClick">
        <Transition name="dialog-pop" appear>
          <div v-if="visible" class="input-container" @click.stop>

            <!-- 顶部装饰光带 -->
            <div class="container-glow" />

            <!-- Header -->
            <div class="input-header">
              <div class="header-left">
                <div class="pulse-dot" />
                <div class="header-label">
                  <span class="header-title">需要你的输入</span>
                  <span class="header-badge">{{ inputTypeLabel }}</span>
                </div>
              </div>
            </div>

            <!-- Body -->
            <div class="input-body">
              <!-- 问题气泡 -->
              <div class="prompt-block">
                <div class="prompt-avatar">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                    fill="currentColor">
                    <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm-1-5h2v2h-2zm0-8h2v6h-2z"/>
                  </svg>
                </div>
                <div class="prompt-text">{{ prompt }}</div>
              </div>

              <!-- 渲染器区域 -->
              <div class="renderer-wrap">
                <component
                  :is="currentRenderer"
                  v-if="currentRenderer"
                  v-model="inputValue"
                  :options="options"
                  :extra="extra"
                  @quick-submit="handleSubmit"
                />
                <!-- 兜底文本 -->
                <div v-else class="fallback-wrap">
                  <textarea
                    ref="textareaRef"
                    v-model="inputValue"
                    class="fallback-textarea"
                    placeholder="请输入..."
                    rows="3"
                    @keydown.ctrl.enter.prevent="handleSubmit"
                    @keydown.meta.enter.prevent="handleSubmit"
                  />
                  <div class="fallback-hint">
                    <kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd><span>提交</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Footer -->
            <div class="input-footer">
              <button class="btn-stop" @click="handleCancel">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                </svg>
                停止任务
              </button>
              <button class="btn-send" :disabled="!canSubmit" @click="handleSubmit">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                  fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                发送
              </button>
            </div>

          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';
import InputRendererText from './input-renderers/InputRendererText.vue';
import InputRendererSelect from './input-renderers/InputRendererSelect.vue';

// ── 渲染器注册表（新增 input_type 只需在此注册一行）──────────────────────
const RENDERER_REGISTRY = {
  text:   InputRendererText,
  select: InputRendererSelect,
};

const TYPE_LABELS = {
  text:   '自由输入',
  select: '单项选择',
};

const emit = defineEmits(['submit', 'cancel']);

const visible    = ref(false);
const prompt     = ref('');
const inputType  = ref('text');
const options    = ref([]);
const extra      = ref({});
const inputValue = ref('');
const textareaRef = ref(null);

let _inputId  = '';
let _onSubmit = null;
let _onCancel = null;

const currentRenderer = computed(() => RENDERER_REGISTRY[inputType.value] ?? null);
const inputTypeLabel  = computed(() => TYPE_LABELS[inputType.value] ?? inputType.value);
const canSubmit       = computed(() => String(inputValue.value ?? '').trim().length > 0);

const show = (data, onSubmit, onCancel) => {
  _inputId        = data.input_id    || '';
  prompt.value    = data.prompt      || '请输入补充信息';
  inputType.value = data.input_type  || 'text';
  options.value   = Array.isArray(data.options) ? data.options : [];
  extra.value     = data.extra       || {};
  inputValue.value = '';
  _onSubmit = onSubmit || null;
  _onCancel = onCancel || null;
  visible.value = true;

  if (inputType.value === 'text') {
    nextTick(() => textareaRef.value?.focus());
  }
};

const hide = () => {
  visible.value = false;
  inputValue.value = '';
};

const handleSubmit = () => {
  if (!canSubmit.value) return;
  const val = String(inputValue.value).trim();
  hide();
  _onSubmit?.(_inputId, val);
  emit('submit', { inputId: _inputId, value: val });
};

const handleCancel = () => {
  hide();
  _onCancel?.(_inputId);
  emit('cancel', { inputId: _inputId });
};

const handleOverlayClick = () => {};

defineExpose({ show, hide });
</script>

<style scoped>
/* ── 遮罩 ── */
.input-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(18px) saturate(1.4);
  -webkit-backdrop-filter: blur(18px) saturate(1.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
}

/* ── 弹窗主体 ── */
.input-container {
  position: relative;
  width: 100%;
  max-width: 480px;
  background: var(--color-bg-primary);
  border-radius: 18px;
  border: 1px solid rgba(99, 179, 237, 0.25);
  box-shadow:
    0 0 0 1px rgba(99, 179, 237, 0.08),
    0 8px 32px rgba(0, 0, 0, 0.45),
    0 32px 80px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

/* 顶部光晕装饰 */
.container-glow {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(99, 179, 237, 0.6) 30%,
    rgba(147, 197, 253, 0.8) 50%,
    rgba(99, 179, 237, 0.6) 70%,
    transparent 100%);
  border-radius: 18px 18px 0 0;
}

/* ── Header ── */
.input-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px 14px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 呼吸动画小点 */
.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent, #63b3ed);
  flex-shrink: 0;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
    box-shadow: 0 0 0 0 rgba(99, 179, 237, 0.5);
  }
  50% {
    opacity: 0.8;
    box-shadow: 0 0 0 5px rgba(99, 179, 237, 0);
  }
}

.header-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.header-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.header-badge {
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--color-accent, #63b3ed);
  background: rgba(99, 179, 237, 0.1);
  border: 1px solid rgba(99, 179, 237, 0.2);
  border-radius: 20px;
  padding: 1px 8px;
  letter-spacing: 0.3px;
}

/* ── Body ── */
.input-body {
  padding: 0 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 问题气泡 */
.prompt-block {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: rgba(99, 179, 237, 0.05);
  border: 1px solid rgba(99, 179, 237, 0.12);
  border-radius: 12px;
  padding: 12px 14px;
}

.prompt-avatar {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(99, 179, 237, 0.15);
  color: var(--color-accent, #63b3ed);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}

.prompt-text {
  font-size: 0.9rem;
  line-height: 1.65;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  flex: 1;
}

/* 渲染器容器 */
.renderer-wrap {
  /* 子组件自行撑开 */
}

/* 兜底文本区 */
.fallback-wrap {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.fallback-textarea {
  width: 100%;
  padding: 10px 13px;
  background: var(--color-bg-secondary);
  border: 1.5px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text-primary);
  font-size: 0.9rem;
  line-height: 1.6;
  resize: none;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-family: inherit;
  box-sizing: border-box;
}

.fallback-textarea:focus {
  border-color: var(--color-accent, #63b3ed);
  box-shadow: 0 0 0 3px rgba(99, 179, 237, 0.12);
}

.fallback-hint {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-end;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.fallback-hint kbd {
  display: inline-flex;
  padding: 1px 5px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.6875rem;
  line-height: 1.5;
}

/* ── Footer ── */
.input-footer {
  display: flex;
  gap: 8px;
  padding: 0 22px 20px;
}

.btn-stop,
.btn-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 18px;
  border-radius: 10px;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  border: none;
  outline: none;
  font-family: inherit;
}

.btn-stop {
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  flex: 0 0 auto;
}

.btn-stop:hover {
  border-color: #ef4444;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.06);
}

.btn-send {
  flex: 1;
  background: var(--color-accent, #63b3ed);
  color: #fff;
  box-shadow: 0 2px 12px rgba(99, 179, 237, 0.3);
}

.btn-send:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 4px 20px rgba(99, 179, 237, 0.45);
  transform: translateY(-1px);
}

.btn-send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-stop:active,
.btn-send:active:not(:disabled) {
  transform: scale(0.97);
}

/* ── 遮罩动画 ── */
.overlay-fade-enter-active,
.overlay-fade-leave-active {
  transition: opacity 0.2s ease;
}
.overlay-fade-enter-from,
.overlay-fade-leave-to {
  opacity: 0;
}

/* ── 弹窗弹入动画 ── */
.dialog-pop-enter-active {
  transition: transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease;
}
.dialog-pop-leave-active {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.dialog-pop-enter-from {
  transform: scale(0.88) translateY(-12px);
  opacity: 0;
}
.dialog-pop-leave-to {
  transform: scale(0.94) translateY(6px);
  opacity: 0;
}

/* ── 响应式 ── */
@media (max-width: 540px) {
  .input-container { border-radius: 14px; max-width: 100%; }
  .input-header, .input-body { padding-inline: 16px; }
  .input-footer { padding: 0 16px 16px; flex-direction: column-reverse; }
  .btn-stop { flex: 1; }
}
</style>
