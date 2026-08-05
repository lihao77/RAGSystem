import type { DocumentToolsRuntimeFactory } from "../../dependencies.js";
import {
  documentToolsEnabled,
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
    if (options.enabled === false || !documentToolsEnabled(context.resources)) return { document: null };
    return {
      document: new LocalDocumentToolService({
        dataRoot: context.dataRoot,
        fileHistory: findDocumentEditHistoryResource(context.resources),
      }),
    };
  };
}
