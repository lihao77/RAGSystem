/** Height offsets include each row's leading gap. Only mounted rows need measurements. */
export function createMessageLayout(keys, sizes, estimate = 112) {
  const offsets = [0];
  for (const key of keys) offsets.push(offsets.at(-1) + (sizes.get(key) ?? estimate));
  return { keys, offsets, total: offsets.at(-1) };
}

export function messageIndexAt(layout, offset) {
  let low = 0;
  let high = layout.keys.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (layout.offsets[middle + 1] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, Math.max(0, layout.keys.length - 1));
}

/** Disjoint pinned rows (streaming tail, editing/expanded rows) retain their real positions. */
export function messageWindowEntries(layout, start, end, pinned = []) {
  if (!layout.keys.length) return [];
  const first = messageIndexAt(layout, Math.max(0, start));
  const last = messageIndexAt(layout, Math.max(start, end));
  const indices = new Set(pinned.filter(index => index >= 0 && index < layout.keys.length));
  for (let index = first; index <= last; index += 1) indices.add(index);
  const result = [];
  let cursor = 0;
  for (const index of [...indices].sort((a, b) => a - b)) {
    if (index > cursor) result.push({ key: `space:${layout.keys[index]}`, height: layout.offsets[index] - layout.offsets[cursor] });
    result.push({ key: layout.keys[index], index });
    cursor = index + 1;
  }
  if (cursor < layout.keys.length) result.push({ key: 'space:end', height: layout.total - layout.offsets[cursor] });
  return result;
}
