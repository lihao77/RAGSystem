/**
 * CSV/TSV 解析（手写状态机，无第三方依赖）。
 *
 * 支持：引号字段（内含分隔符/换行/转义引号 ""）、\r\n 与 \n 混排、结尾不完整引号。
 * 返回 complete 标记，调用方在文本被截断时应丢弃末行避免展示半个单元格。
 */

/**
 * 解析分隔符文本。
 * @param {string} text 原始文本
 * @param {string} [delimiter] 分隔符，默认 ','
 * @returns {{ rows: string[][], complete: boolean }}
 */
export function parseDelimited(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  let complete = true;

  const pushCell = () => { row.push(cell); cell = ''; };
  const pushRow = () => {
    pushCell();
    // 跳过完全空行（连续换行）
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } // 转义引号
        else inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      pushCell();
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      pushRow();
      continue;
    }
    cell += char;
  }

  if (inQuotes) complete = false;
  // 结尾没有换行符的最后一行
  if (cell !== '' || row.length > 0) pushRow();

  return { rows, complete };
}

/**
 * 解析为表格结构（首行作表头）。
 * @param {string} text
 * @param {{ delimiter?: string, maxRows?: number }} [options]
 * @returns {{ headers: string[], rows: string[][], totalRows: number, shownRows: number, truncated: boolean, complete: boolean }}
 */
export function parseCsvTable(text, options = {}) {
  const { delimiter = ',', maxRows = Infinity } = options;
  const { rows, complete } = parseDelimited(text, delimiter);

  // 文本被截断导致引号未闭合时，末行不可信，丢弃
  const safeRows = complete ? rows : rows.slice(0, -1);
  const [headers = [], ...dataRows] = safeRows;
  const totalRows = dataRows.length;
  const shown = dataRows.slice(0, maxRows);

  return {
    headers,
    rows: shown,
    totalRows,
    shownRows: shown.length,
    truncated: shown.length < totalRows || !complete,
    complete,
  };
}
