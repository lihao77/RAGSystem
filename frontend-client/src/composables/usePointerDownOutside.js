import { onBeforeUnmount, onMounted, unref } from 'vue';

const globalInsideEntries = new Set();

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveElement(item) {
  const value = typeof item === 'function' ? item() : unref(item);
  return unref(value);
}

function resolveElements(inside) {
  const value = typeof inside === 'function' ? inside() : unref(inside);
  return toArray(value)
    .flatMap(item => toArray(resolveElement(item)))
    .map(item => unref(item))
    .filter(Boolean);
}

function isEnabled(enabled) {
  return typeof enabled === 'function' ? enabled() : unref(enabled);
}

function getAllInsideElements(inside) {
  return [
    ...resolveElements(inside),
    ...Array.from(globalInsideEntries).flatMap(entry => (
      isEnabled(entry.enabled) ? resolveElements(entry.inside) : []
    )),
  ];
}

export function isPointerInside(event, inside) {
  const elements = getAllInsideElements(inside);
  if (!elements.length) return false;

  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return elements.some((element) => {
    if (path.includes(element)) return true;
    return typeof element.contains === 'function' && element.contains(event.target);
  });
}

export function registerPointerInside(inside, enabled = true) {
  const entry = { inside, enabled };
  globalInsideEntries.add(entry);
  return () => {
    globalInsideEntries.delete(entry);
  };
}

export function usePointerInsideRegistry(inside, enabled = true) {
  let unregister;

  onMounted(() => {
    unregister = registerPointerInside(inside, enabled);
  });

  onBeforeUnmount(() => {
    unregister?.();
  });
}

export function usePointerDownOutside({
  inside,
  enabled = true,
  onOutside,
  target = () => document,
  capture = true,
}) {
  const handler = (event) => {
    if (!isEnabled(enabled)) return;
    if (isPointerInside(event, inside)) return;
    onOutside?.(event);
  };

  onMounted(() => {
    target()?.addEventListener('pointerdown', handler, capture);
  });

  onBeforeUnmount(() => {
    target()?.removeEventListener('pointerdown', handler, capture);
  });

  return {
    isPointerInside: event => isPointerInside(event, inside),
  };
}
