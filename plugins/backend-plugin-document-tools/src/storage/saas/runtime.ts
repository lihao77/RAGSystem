import type { DocumentToolsRuntimeFactory } from "../../dependencies.js";
import { findDocumentToolsSandbox } from "../../resources.js";
import { SaaSDocumentToolService } from "./sandbox-document-tools.js";

export function createSandboxedDocumentToolsRuntimeFactory(): DocumentToolsRuntimeFactory {
  return (context) => {
    const sandbox = findDocumentToolsSandbox(context.resources);
    return sandbox ? { document: new SaaSDocumentToolService(sandbox) } : { document: null };
  };
}
