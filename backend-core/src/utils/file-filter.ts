/**
 * 文件名归一化 / 文件过滤的共享纯函数。
 *
 * 抽取自原 file-index-service(uploaded_files session 附件)与 sqlite-vec-driver(kb_files 知识库文件)
 * 两处逐字重复的实现——两套数据源对“存储文件名归一化”和“按扩展名/MIME 过滤”语义完全一致,统一在此消除重复。
 */

/**
 * 存储文件名归一化:保留 [\w\-.](ASCII 字母数字下划线/连字符/点),其余替换为 `_`,首尾下划线裁掉;
 * 结果为空回退 `upload.bin`。用于生成 stored_name 的可读后缀(随机前缀防冲突)。
 *
 * 注:HTTP content-disposition 头的安全转义是另一套语义(file-route-utils.sanitizeHeaderFilename),不在此处。
 */
export function sanitizeFilename(filename: string): string {
  const normalized = filename.replace(/[^\w\-.]/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "upload.bin";
}

/**
 * 归一化过滤列表:trim + 小写 + 去空。extensions / mimeTypes 通用。
 */
export function normalizeFilterList(values?: string[]): string[] {
  return (values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * 扩展名归一化:在 normalizeFilterList 基础上保证 `.ext` 前缀。
 * 避免 `endsWith("pdf")` 误匹配无扩展名文件名(如 `reportpdf`)——统一为 `.pdf` 后精确匹配扩展名边界。
 */
export function normalizeExtensions(values?: string[]): string[] {
  return normalizeFilterList(values).map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));
}

/**
 * 按 extensions / mimeTypes 过滤单个文件:
 * - extensions:并集 OR,按 original_name 后缀匹配(扩展名自动补点);
 * - mimeTypes:并集 OR,按 mime 精确(小写)匹配;
 * - 两者同时给:满足任一即命中(OR);
 * - 都不给:全部命中(不过滤)。
 */
export function matchesFileFilters(
  originalName: string,
  mime: string,
  extensions?: string[],
  mimeTypes?: string[],
): boolean {
  const extList = normalizeExtensions(extensions);
  const mimeList = normalizeFilterList(mimeTypes);
  const matchesExt = extList.some((ext) => originalName.toLowerCase().endsWith(ext));
  const matchesMime = mimeList.some((m) => mime.toLowerCase() === m);

  if (extList.length && mimeList.length) {
    return matchesExt || matchesMime;
  }
  if (extList.length) {
    return matchesExt;
  }
  if (mimeList.length) {
    return matchesMime;
  }
  return true;
}
