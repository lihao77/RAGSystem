<template>
  <div class="admin-layout">
    <main class="admin-main">
      <slot />
    </main>
  </div>
</template>

<script setup>
defineOptions({ inheritAttrs: false });
</script>

<style scoped>
.admin-layout {
  display: flex;
  height: 100%;
  width: 100%;
  background: var(--color-bg-app);
  overflow: hidden;
}

.admin-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>
