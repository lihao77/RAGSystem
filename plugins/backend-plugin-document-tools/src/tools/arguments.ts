import { asString } from "@ragsystem/backend-core/utils/guards.js";

export function readFileArguments(value: Record<string, unknown> | undefined) {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    offset: asInteger(value?.offset),
    limit: asInteger(value?.limit),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

export function writeFileArguments(value: Record<string, unknown> | undefined) {
  return {
    content: value?.content ?? "",
    filePath: asString(value?.file_path) ?? asString(value?.filePath),
    encoding: asString(value?.encoding),
    mode: asString(value?.mode),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

export function editFileArguments(value: Record<string, unknown> | undefined) {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    // old_string 是精确匹配目标，前导/尾部空白（缩进、换行）具有语义，不能 trim。
    oldString: asStringPreservingWhitespace(value?.old_string) ?? asStringPreservingWhitespace(value?.oldString) ?? "",
    newString: typeof value?.new_string === "string"
      ? value.new_string
      : typeof value?.newString === "string"
        ? value.newString
        : "",
    encoding: asString(value?.encoding),
    replaceAll: typeof value?.replace_all === "boolean"
      ? value.replace_all
      : typeof value?.replaceAll === "boolean"
        ? value.replaceAll
        : null,
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

/** 原样保留空白字符串（仅校验类型，不做 trim）——用于需要精确匹配的字段。 */
function asStringPreservingWhitespace(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function previewDataStructureArguments(value: Record<string, unknown> | undefined) {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    maxPreviewRows: asInteger(value?.max_preview_rows) ?? asInteger(value?.maxPreviewRows),
    maxDepth: asInteger(value?.max_depth) ?? asInteger(value?.maxDepth),
    maxFields: asInteger(value?.max_fields) ?? asInteger(value?.maxFields),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
