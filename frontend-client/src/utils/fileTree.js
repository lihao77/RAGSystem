/**
 * 把扁平的文件路径列表折叠成目录树，再按折叠状态展开为渲染用扁平列表。
 * 目录在前、同级按名称排序；collapsed 为目录路径集合。
 */

export function flattenFileTree(files, collapsed) {
  const root = { children: [] };
  for (const file of files || []) {
    const path = String(file.path || '').replaceAll('\\', '/');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) continue;
    let parent = root;
    parts.forEach((part, index) => {
      const nodePath = parts.slice(0, index + 1).join('/');
      const last = index === parts.length - 1;
      let node = parent.children.find((child) => child.name === part);
      if (!node) {
        node = {
          name: part,
          path: nodePath,
          type: last ? (file.type || 'file') : 'directory',
          size: last ? file.size : undefined,
          children: [],
        };
        parent.children.push(node);
      }
      parent = node;
    });
  }
  const sort = (nodes) => {
    nodes.sort((left, right) => left.type === right.type
      ? left.name.localeCompare(right.name)
      : left.type === 'directory' ? -1 : 1);
    nodes.forEach((node) => sort(node.children));
  };
  sort(root.children);
  const flattened = [];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const isCollapsed = node.type === 'directory' && collapsed.has(node.path);
      flattened.push({ ...node, depth, collapsed: isCollapsed });
      if (node.type === 'directory' && !isCollapsed) walk(node.children, depth + 1);
    }
  };
  walk(root.children, 0);
  return flattened;
}

export function togglePathInSet(collapsedSet, path) {
  const next = new Set(collapsedSet);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
