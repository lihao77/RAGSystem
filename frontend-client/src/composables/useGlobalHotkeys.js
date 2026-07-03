import { ref } from 'vue';

// 模块级单例（与 useCommandPalette 一致的模式）
// bindings: { id, combo, description, group, action }
//   combo 形态：单键 '/'、'c'；序列 'g c'；alt 组合 'alt+arrowup'
const bindings = ref([]);
const helpVisible = ref(false);
const registered = new Map();

function register(items) {
  for (const item of items || []) {
    if (item && item.id && !registered.has(item.id)) {
      registered.set(item.id, item);
      bindings.value.push(item);
    }
  }
}

function unregister(id) {
  if (!registered.has(id)) return;
  registered.delete(id);
  bindings.value = bindings.value.filter((b) => b.id !== id);
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!el.isContentEditable;
}

function normKey(e) {
  let k = e.key;
  if (k === ' ') k = 'space';
  return k.toLowerCase();
}

let seqPending = null;
const SEQ_TIMEOUT = 800;
function clearSeq() {
  if (seqPending && seqPending.timer) clearTimeout(seqPending.timer);
  seqPending = null;
}

let installed = false;
function install() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // 内置：? 切换帮助面板
  register([
    { id: '__help', combo: '?', description: '快捷键帮助', group: '帮助', action: () => { helpVisible.value = !helpVisible.value; } },
  ]);
  window.addEventListener('keydown', (e) => {
    // Esc 关帮助（最高优先级，任意态）
    if (helpVisible.value && e.key === 'Escape') {
      e.preventDefault();
      helpVisible.value = false;
      return;
    }
    const typing = isTypingTarget(e.target);
    // 输入态：不劫持任何键（Esc 已处理）
    if (typing) return;
    // Cmd/Ctrl 组合留给命令面板等其他监听
    if (e.metaKey || e.ctrlKey) return;

    const key = normKey(e);
    const altCombo = e.altKey ? `alt+${key}` : null;

    // 序列续接（g <x>）
    if (seqPending) {
      const combo2 = `${seqPending.prefix} ${key}`;
      clearSeq();
      const b2 = bindings.value.find((x) => x.combo === combo2);
      if (b2) { e.preventDefault(); b2.action(); return; }
      // 未命中：fall through，当前键继续按单键 / 序列起始判断
    }

    // alt 组合（会话切换等）
    if (altCombo) {
      const ba = bindings.value.find((x) => x.combo === altCombo);
      if (ba) { e.preventDefault(); ba.action(); return; }
      return; // 其它 alt 组合放行
    }

    // 单键
    const b = bindings.value.find((x) => x.combo === key);
    if (b) { e.preventDefault(); b.action(); return; }

    // 序列起始：存在以该键为前缀的序列则进入等待
    const prefix = `${key} `;
    if (bindings.value.some((x) => x.combo.startsWith(prefix))) {
      seqPending = { prefix: key, timer: setTimeout(clearSeq, SEQ_TIMEOUT) };
      e.preventDefault();
    }
  });
}

export function useGlobalHotkeys() {
  return { register, unregister, install, helpVisible, bindings };
}
