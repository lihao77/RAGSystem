import type { DocumentToolsRuntimeFactory } from "../../dependencies.js";
import {
  DOCUMENT_TOOLS_ENABLED_RESOURCE,
  findDocumentEditHistoryResource,
} from "../../resources.js";
import { LocalDocumentToolService } from "../../tools/DocumentTools/DocumentExecution.js";

export interface LocalDocumentToolsRuntimeFactoryOptions {
  enabled?: boolean;
}

export function createLocalDocumentToolsRuntimeFactory(
  options: LocalDocumentToolsRuntimeFactoryOptions = {},
): DocumentToolsRuntimeFactory {
  return (context) => {
    if (context.deploymentKind !== "local") {
      throw new Error("Local document tools runtime requires a Local deployment");
    }
    const runtimeEnabled = context.resources?.find((resource) => resource.kind === DOCUMENT_TOOLS_ENABLED_RESOURCE)?.value;
    if (options.enabled === false || runtimeEnabled === false) return { document: null };
    return {
      document: new LocalDocumentToolService({
        dataRoot: context.dataRoot,
        fileHistory: findDocumentEditHistoryResource(context.resources),
      }),
    };
  };
}
