<template>
  <div id="app">
    <ChatViewV2 :selected-llm="selectedLLM" :is-dark="isDark"
      @update:selectedLLM="selectedLLM = $event" @toggle-theme="toggleTheme" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import ChatViewV2 from './views/ChatViewV2.vue';
import 'highlight.js/styles/github-dark.css';

const isDark = ref(true);
const selectedLLM = ref('');

const toggleTheme = () => {
  isDark.value = !isDark.value;
  updateTheme();
};

const updateTheme = () => {
  const root = document.documentElement;
  if (isDark.value) {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.setAttribute('data-theme', 'light');
  }
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
};

onMounted(() => {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    isDark.value = savedTheme === 'dark';
  } else {
    isDark.value = true;
  }
  updateTheme();

  const savedLLM = localStorage.getItem('selectedLLMModel');
  if (savedLLM) {
    selectedLLM.value = savedLLM;
  }
});
</script>

<style>
/* App.vue 不再需要控制栏样式，已移到 ChatViewV2 */
</style>
