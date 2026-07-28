import { createCapability } from "@ragsystem/backend-core/plugins/capability-registry.js";
import type { DocumentToolPort } from "./contracts.js";

export interface DocumentToolsRuntimeCapability {
  readonly document: DocumentToolPort | null;
}

export const DOCUMENT_TOOLS_RUNTIME_CAPABILITY = createCapability<DocumentToolsRuntimeCapability>(
  "@ragsystem/backend-plugin-document-tools/runtime",
);
