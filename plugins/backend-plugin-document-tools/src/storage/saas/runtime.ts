import type { DocumentToolsRuntimeFactory } from "../../dependencies.js";
import { findDocumentToolsRuntimeResource } from "../../resources.js";

export function createSaaSDocumentToolsRuntimeFactory(): DocumentToolsRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "saas") {
      throw new Error("SaaS document tools runtime requires a SaaS deployment");
    }
    return findDocumentToolsRuntimeResource(context.resources) ?? { document: null };
  };
}
