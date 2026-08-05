import type { DocumentToolsRuntimeFactory } from "../../dependencies.js";
import { findDocumentToolsSandbox } from "../../resources.js";
import { SaaSDocumentToolService } from "./sandbox-document-tools.js";

export function createSaaSDocumentToolsRuntimeFactory(): DocumentToolsRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("SaaS document tools runtime requires a SaaS deployment");
    }
    const sandbox = findDocumentToolsSandbox(context.resources);
    return sandbox ? { document: new SaaSDocumentToolService(sandbox) } : { document: null };
  };
}
