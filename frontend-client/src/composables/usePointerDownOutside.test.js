import test from 'node:test';
import assert from 'node:assert/strict';

import { isPointerInside, registerPointerInside } from './usePointerDownOutside.js';

function element(children = []) {
  return {
    children,
    contains(target) {
      return target === this || this.children.some(child => child === target || child.contains?.(target));
    },
  };
}

function eventFor(target, path = []) {
  return {
    target,
    composedPath: () => path,
  };
}

test('isPointerInside 识别内部元素', () => {
  const child = element();
  const root = element([child]);

  assert.equal(isPointerInside(eventFor(child), [() => root]), true);
});

test('isPointerInside 识别外部元素', () => {
  const root = element();
  const outside = element();

  assert.equal(isPointerInside(eventFor(outside), [() => root]), false);
});

test('isPointerInside 支持多个内部元素', () => {
  const trigger = element();
  const option = element();
  const dropdown = element([option]);

  assert.equal(isPointerInside(eventFor(trigger), [() => trigger, () => dropdown]), true);
  assert.equal(isPointerInside(eventFor(option), [() => trigger, () => dropdown]), true);
});

test('isPointerInside 优先使用 composedPath', () => {
  const root = element();
  const target = element();

  assert.equal(isPointerInside(eventFor(target, [target, root]), [() => root]), true);
});

test('registerPointerInside 将 Teleport 浮层注册为全局内部区域', () => {
  const panel = element();
  const option = element();
  const dropdown = element([option]);

  const unregister = registerPointerInside([() => dropdown], true);
  assert.equal(isPointerInside(eventFor(option), [() => panel]), true);

  unregister();
  assert.equal(isPointerInside(eventFor(option), [() => panel]), false);
});

test('registerPointerInside 的 enabled=false 时不生效', () => {
  const panel = element();
  const dropdown = element();

  const unregister = registerPointerInside([() => dropdown], () => false);
  assert.equal(isPointerInside(eventFor(dropdown), [() => panel]), false);
  unregister();
});
