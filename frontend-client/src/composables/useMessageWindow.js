import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { createMessageLayout, messageIndexAt, messageWindowEntries } from '../utils/messageWindow.js';

/** Virtualize within the existing conversation scroll container, including its composer. */
export function useMessageWindow({ rows, stream, container, following, contextKey, editingMessage, threshold = 200 }) {
  const sizes = new Map();
  const elements = new Map();
  const callbacks = new Map();
  const expanded = new Set();
  const latched = ref(false);
  const showAll = ref(false);
  const active = computed(() => Boolean(container.value && latched.value && !showAll.value));
  const layout = shallowRef(createMessageLayout([], sizes));
  const viewport = shallowRef({ start: 0, end: 900 });
  const pinsRevision = ref(0);
  const navigationKey = ref(null);
  let frame = null;
  let observer = null;
  let scroller = null;
  let previousOverflowAnchor = '';
  let width = 0;
  let disposed = false;

  const listTop = () => stream.value && container.value
    ? stream.value.getBoundingClientRect().top - container.value.getBoundingClientRect().top + container.value.scrollTop
    : 0;
  const instantScroll = (top) => {
    const host = container.value;
    if (!host) return;
    const behavior = host.style.scrollBehavior;
    host.style.scrollBehavior = 'auto';
    host.scrollTop = top;
    host.style.scrollBehavior = behavior;
  };
  const captureAnchor = () => {
    if (!container.value || !layout.value.keys.length) return null;
    if (!active.value) {
      const top = container.value.getBoundingClientRect().top;
      let candidate = null;
      for (const [key, element] of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > top && (!candidate || rect.top < candidate.top)) candidate = { key, top: rect.top, element };
      }
      if (candidate) return { key: candidate.key, offset: top - candidate.top + (parseFloat(getComputedStyle(candidate.element).marginTop) || 0) };
    }
    const offset = Math.max(0, container.value.scrollTop - listTop());
    const index = messageIndexAt(layout.value, offset);
    return { key: layout.value.keys[index], offset: offset - layout.value.offsets[index] };
  };
  const restoreAnchor = (anchor) => {
    if (following.value) { instantScroll(container.value?.scrollHeight || 0); return; }
    if (!anchor) return;
    const index = layout.value.keys.indexOf(anchor.key);
    if (index < 0) return;
    instantScroll(listTop() + layout.value.offsets[index] + anchor.offset);
  };
  const updateViewport = () => {
    if (!container.value) return;
    const start = Math.max(0, container.value.scrollTop - listTop());
    viewport.value = { start: Math.max(0, start - 900), end: start + container.value.clientHeight + 900 };
  };
  const rebuild = () => {
    layout.value = createMessageLayout(rows.value.map(row => row.key), sizes);
  };
  const keepMounted = element => Boolean(element.querySelector('[aria-expanded="true"], .is-expanded, .assistant-execution-list-outer.is-open')
    || element.contains(document.activeElement));
  const primeSizes = () => {
    for (const [key, element] of elements) {
      sizes.set(key, element.getBoundingClientRect().height + (parseFloat(getComputedStyle(element).marginTop) || 0));
      if (keepMounted(element)) expanded.add(key);
    }
    width = stream.value?.clientWidth || 0;
    pinsRevision.value += 1;
  };
  const measure = () => {
    frame = null;
    if (!active.value || !stream.value || !container.value || disposed) return;
    const anchor = captureAnchor();
    let changed = false;
    if (Math.abs(width - stream.value.clientWidth) > 1) {
      width = stream.value.clientWidth;
      sizes.clear();
      changed = true;
    }
    let pinsChanged = false;
    for (const [key, element] of elements) {
      if (!element.isConnected) continue;
      const height = element.getBoundingClientRect().height;
      if (height > 0 && Math.abs((sizes.get(key) ?? -1) - height) > 0.5) {
        sizes.set(key, height);
        changed = true;
      }
      const keep = keepMounted(element);
      if (keep !== expanded.has(key)) {
        if (keep) expanded.add(key); else expanded.delete(key);
        pinsChanged = true;
      }
    }
    if (pinsChanged) pinsRevision.value += 1;
    if (changed) {
      rebuild();
      nextTick(() => {
        if (disposed || !active.value) return;
        restoreAnchor(anchor);
        updateViewport();
      });
    } else updateViewport();
  };
  const scheduleMeasure = () => {
    if (frame === null && !disposed) frame = requestAnimationFrame(measure);
  };
  const handleScroll = () => { navigationKey.value = null; scheduleMeasure(); };
  const bindRow = (key) => {
    if (!callbacks.has(key)) callbacks.set(key, (instance) => {
      const element = instance?.$el || instance;
      const previous = elements.get(key);
      if (previous && previous !== element) observer?.unobserve(previous);
      if (element?.nodeType === 1) {
        elements.set(key, element);
        if (active.value) observer?.observe(element);
      } else elements.delete(key);
      if (active.value) scheduleMeasure();
    });
    return callbacks.get(key);
  };
  const pinnedIndices = computed(() => {
    void pinsRevision.value;
    const count = rows.value.length;
    const pins = [count - 2, count - 1];
    rows.value.forEach((row, index) => {
      if (expanded.has(row.key) || navigationKey.value === row.key || row.msg === editingMessage.value) pins.push(index);
    });
    return pins;
  });
  const entries = computed(() => active.value
    ? messageWindowEntries(layout.value, viewport.value.start, viewport.value.end, pinnedIndices.value)
    : rows.value.map((row, index) => ({ key: row.key, index })));

  watch(rows, (next) => {
    const anchor = captureAnchor();
    const keys = new Set(next.map(row => row.key));
    for (const key of sizes.keys()) if (!keys.has(key)) sizes.delete(key);
    for (const key of callbacks.keys()) if (!keys.has(key)) { callbacks.delete(key); expanded.delete(key); }
    // Prime measured sizes before switching a growing short conversation to windowing.
    if (!latched.value && next.length >= threshold) {
      primeSizes();
      latched.value = true;
    }
    if (!next.length) { latched.value = false; showAll.value = false; }
    rebuild();
    nextTick(() => {
      if (disposed) return;
      if (active.value) { restoreAnchor(anchor); scheduleMeasure(); }
      updateViewport();
    });
  }, { immediate: true });
  watch(contextKey, () => { sizes.clear(); expanded.clear(); showAll.value = false; latched.value = rows.value.length >= threshold; rebuild(); });

  const detach = () => {
    observer?.disconnect();
    observer = null;
    if (scroller) {
      scroller.removeEventListener('scroll', handleScroll);
      scroller.style.overflowAnchor = previousOverflowAnchor;
    }
    scroller = null;
  };
  watch([container, stream, active], () => {
    detach();
    if (!active.value || !container.value || !stream.value) return;
    scroller = container.value;
    previousOverflowAnchor = scroller.style.overflowAnchor;
    scroller.style.overflowAnchor = 'none';
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    observer = new ResizeObserver(scheduleMeasure);
    observer.observe(stream.value);
    for (const element of elements.values()) observer.observe(element);
    updateViewport();
    scheduleMeasure();
  }, { flush: 'post' });

  async function scrollToMessage(target) {
    const index = typeof target === 'number' ? target : rows.value.findIndex(row => row.key === target || row.msg.id === target || `seq:${row.msg.seq}` === target);
    const row = rows.value[index];
    if (!row || !container.value) return null;
    navigationKey.value = row.key;
    await nextTick();
    for (let pass = 0; pass < 3; pass += 1) {
      if (disposed) return null;
      if (active.value) instantScroll(listTop() + layout.value.offsets[index]);
      else {
        const element = elements.get(row.key);
        if (element) instantScroll(container.value.scrollTop + element.getBoundingClientRect().top - container.value.getBoundingClientRect().top);
      }
      updateViewport();
      await nextTick();
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return elements.get(row.key) || null;
  }
  async function toggleAll(value = !showAll.value) {
    if (value === showAll.value) return;
    const anchor = captureAnchor();
    if (showAll.value) { primeSizes(); rebuild(); }
    const element = anchor && elements.get(anchor.key);
    const screenTop = element ? element.getBoundingClientRect().top + (parseFloat(getComputedStyle(element).paddingTop) || 0) : null;
    navigationKey.value = anchor?.key || null;
    showAll.value = value;
    await nextTick();
    const restored = anchor && elements.get(anchor.key);
    if (restored && screenTop !== null) instantScroll(container.value.scrollTop + restored.getBoundingClientRect().top + (parseFloat(getComputedStyle(restored).paddingTop) || 0) - screenTop);
    updateViewport();
    if (active.value) scheduleMeasure();
  }
  const onFind = event => {
    if (container.value && latched.value && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') toggleAll(true);
  };
  if (typeof window !== 'undefined') window.addEventListener('keydown', onFind);
  onScopeDispose(() => {
    disposed = true;
    detach();
    if (frame !== null) cancelAnimationFrame(frame);
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onFind);
  });
  return { active, latched, showAll, entries, bindRow, scheduleMeasure, scrollToMessage, toggleAll };
}
