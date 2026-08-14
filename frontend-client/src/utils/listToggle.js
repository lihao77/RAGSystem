/** 原地切换列表成员存在性（供 CheckGrid 等多选网格使用）。 */
export function toggleListItem(list, name) {
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
}
