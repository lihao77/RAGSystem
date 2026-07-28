import type { DocumentToolsRuntimeCapability } from "./capability.js";
import type { DocumentEditHistoryPort } from "./contracts.js";

export const DOCUMENT_TOOLS_RUNTIME_RESOURCE = "document-tools.runtime";
export const DOCUMENT_TOOLS_ENABLED_RESOURCE = "document-tools.enabled";
export const DOCUMENT_TOOLS_EDIT_HISTORY_RESOURCE = "document-tools.edit-history";

export function findDocumentToolsRuntimeResource(
  resources: readonly { kind: string; value: unknown }[] | undefined,
): DocumentToolsRuntimeCapability | null {
  const value = resources?.find((resource) => resource.kind === DOCUMENT_TOOLS_RUNTIME_RESOURCE)?.value;
  if (!value || typeof value !== "object") return null;
  return value as DocumentToolsRuntimeCapability;
}

export function findDocumentEditHistoryResource(
  resources: readonly { kind: string; value: unknown }[] | undefined,
): DocumentEditHistoryPort | null {
  const value = resources?.find((resource) => resource.kind === DOCUMENT_TOOLS_EDIT_HISTORY_RESOURCE)?.value;
  if (!value || typeof value !== "object" || !("trackEdit" in value) || typeof value.trackEdit !== "function") return null;
  return value as DocumentEditHistoryPort;
}
