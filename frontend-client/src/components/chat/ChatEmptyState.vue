<template>
  <section class="new-chat-start" aria-label="新聊天起始页">
    <div class="new-chat-start__eyebrow">New chat</div>
    <h1>想让 Agent 做什么？</h1>
    <p>代码库、知识库、自动化任务，先定一个清晰目标。</p>
    <div class="new-chat-prompts" aria-label="快捷开始">
      <button
        v-for="item in suggestions"
        :key="item.title"
        type="button"
        class="new-chat-prompt"
        @click="emit('selectPrompt', item.prompt)"
      >
        <span class="new-chat-prompt__title">{{ item.title }}</span>
        <span class="new-chat-prompt__desc">{{ item.desc }}</span>
      </button>
    </div>
  </section>
</template>

<script setup>
const emit = defineEmits(['selectPrompt']);

const suggestions = [
  {
    title: '梳理代码库',
    desc: '找出入口、模块关系和下一步改造点',
    prompt: '请先梳理这个代码库的结构，说明主要模块、启动入口和最值得优先改进的地方。',
  },
  {
    title: '实现一个改动',
    desc: '描述目标后直接进入修改和验证',
    prompt: '请根据当前项目实现这个改动：',
  },
  {
    title: '排查问题',
    desc: '从现象定位原因并给出修复',
    prompt: '请帮我排查这个问题，先定位原因，再给出最小修复方案：',
  },
  {
    title: '生成方案',
    desc: '把模糊需求拆成可执行步骤',
    prompt: '请把下面这个需求拆成清晰的实施方案，并指出风险点：',
  },
];
</script>

<style scoped>
.new-chat-start {
  width: min(800px, 100%);
  margin: 0 auto;
  text-align: left;
  transition:
    opacity 280ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 320ms cubic-bezier(0.22, 1, 0.36, 1),
    filter 320ms cubic-bezier(0.22, 1, 0.36, 1);
  animation: titleFadeIn 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.new-chat-start__eyebrow {
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.new-chat-start h1 {
  margin: 0;
  color: var(--color-text-primary);
  font-size: clamp(32px, 5vw, 54px);
  line-height: 1.04;
  font-weight: 760;
  letter-spacing: 0;
}

.new-chat-start p {
  max-width: 560px;
  margin: 14px 0 0;
  color: var(--color-text-secondary);
  font-size: 15px;
  line-height: 1.7;
}

.new-chat-prompts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 28px;
}

.new-chat-prompt {
  min-height: 84px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 7px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: rgba(var(--color-bg-elevated-rgb), 0.46);
  color: var(--color-text-primary);
  text-align: left;
  cursor: pointer;
  box-shadow: none;
  transition:
    background-color 180ms ease,
    border-color 180ms ease,
    transform 180ms ease;
}

.new-chat-prompt:hover {
  transform: translateY(-1px);
  border-color: var(--color-border-hover);
  background: rgba(var(--color-bg-elevated-rgb), 0.7);
}

.new-chat-prompt:active {
  transform: translateY(0);
}

.new-chat-prompt:focus-visible {
  outline: 2px solid rgba(var(--color-brand-accent-rgb), 0.42);
  outline-offset: 2px;
}

.new-chat-prompt__title {
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
}

.new-chat-prompt__desc {
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

@keyframes titleFadeIn {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 767px) {
  .new-chat-start h1 {
    font-size: 34px;
  }

  .new-chat-prompts {
    grid-template-columns: 1fr;
    margin-top: 20px;
  }

  .new-chat-prompt {
    min-height: 72px;
    padding: 13px 14px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .new-chat-start {
    animation: none !important;
    transition: none !important;
  }
}
</style>
