<template>
  <!-- 压缩进行中的横线占位（手动 /compact 与 run 内自动压缩共用）：文字用与工具调用步骤
       同款的"光拂过"效果。终态：手动由 command_result 的横线（CommandResultMessage）接管，
       自动压缩直接移除、不留标记。纯客户端瞬态项（metadata.msg_type = context_compression_pending），
       不持久化；刷新后由 maintenance·compact 租约派生恢复（仅手动路径有租约）。 -->
  <div class="compact-pending-divider" role="status" aria-live="polite">
    <span class="divider-line" />
    <span class="divider-text">正在压缩…</span>
    <span class="divider-line" />
  </div>
</template>

<script setup>
</script>

<style scoped>
.compact-pending-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.75rem 0;
  font-size: var(--font-size-sm, 13px);
  line-height: 1.5;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: var(--color-border, #e0e0e0);
  min-width: 1.5rem;
}

/* 与 AssistantExecutionNode 的 assistant-step-sweep 同款光拂过：渐变裁切到文字上，
   size 300% 且位移 150%→0% 保证无缝循环（两端相位相同、名字落在光带外的静默区），
   改百分比必须保持这两条约束。周期 3s：扫过 ~1.5s + 静默 ~1.5s。 */
.divider-text {
  background: linear-gradient(
    100deg,
    var(--color-text-muted) 42%,
    var(--color-text-primary) 50%,
    var(--color-text-muted) 58%
  );
  background-size: 300% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: compact-pending-sweep 3s linear infinite;
}

@keyframes compact-pending-sweep {
  from { background-position: 150% 0; }
  to { background-position: 0% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .divider-text {
    animation: none;
    color: var(--color-text-muted);
    background: none;
  }
}
</style>
