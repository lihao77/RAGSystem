import { ref, computed } from 'vue';

// 模块级单例状态（全局唯一命令面板）
const visible = ref(false);
const query = ref('');
const activeIndex = ref(0);
const staticCommands = ref([]);
const dynamicCommands = ref({});

function normalize(str) {
  return (str == null ? '' : String(str)).toLowerCase();
}

const allCommands = computed(() => {
  const dyn = Object.values(dynamicCommands.value).flat();
  return [...staticCommands.value, ...dyn];
});

const filtered = computed(() => {
  const q = normalize(query.value).trim();
  if (!q) return allCommands.value;
  return allCommands.value.filter((cmd) => {
    const hay = `${cmd.title || ''} ${cmd.subtitle || ''} ${cmd.section || ''} ${cmd.keywords || ''}`;
    return normalize(hay).includes(q);
  });
});

const existingIds = new Set();
function register(items) {
  for (const item of items || []) {
    if (item && item.id && !existingIds.has(item.id)) {
      staticCommands.value.push(item);
      existingIds.add(item.id);
    }
  }
}

// 动态命令源（如最近会话）：setter 触发 filtered 重算
function setDynamic(id, items) {
  dynamicCommands.value = { ...dynamicCommands.value, [id]: items || [] };
}

function clearDynamic(id) {
  const next = { ...dynamicCommands.value };
  delete next[id];
  dynamicCommands.value = next;
}

function open() {
  query.value = '';
  activeIndex.value = 0;
  visible.value = true;
}

function close() {
  visible.value = false;
}

function toggle() {
  if (visible.value) close();
  else open();
}

function move(delta) {
  const len = filtered.value.length;
  if (!len) return;
  activeIndex.value = (activeIndex.value + delta + len) % len;
}

function runActive() {
  const cmd = filtered.value[activeIndex.value];
  if (!cmd) return;
  close();
  if (typeof cmd.action === 'function') cmd.action();
}

let hotkeyInstalled = false;
function installHotkey() {
  if (hotkeyInstalled || typeof window === 'undefined') return;
  hotkeyInstalled = true;
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    }
  });
}

export function useCommandPalette() {
  return {
    visible,
    query,
    activeIndex,
    filtered,
    register,
    setDynamic,
    clearDynamic,
    open,
    close,
    toggle,
    move,
    runActive,
    installHotkey,
  };
}
