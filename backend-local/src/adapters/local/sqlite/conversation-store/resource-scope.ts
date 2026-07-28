import path from "node:path";

import { asString, isPathUnder } from "./helpers.js";

export function inferResourceScope(input: {
  dataRoot: string;
  resourcePath: string;
  workspaceRoot: string | null;
}): string {
  const workspaceRoot = asString(input.workspaceRoot);
  if (workspaceRoot && isPathUnder(input.resourcePath, workspaceRoot)) {
    return "workspace";
  }

  const sessionsRoot = path.join(input.dataRoot, "sessions");
  if (isPathUnder(input.resourcePath, sessionsRoot)) {
    const relative = path.relative(path.resolve(sessionsRoot), path.resolve(input.resourcePath));
    const parts = relative.split(path.sep).filter(Boolean);
    if (parts.length >= 2) {
      const bucket = parts[1];
      if (bucket === "uploads") {
        return "upload";
      }
      if (bucket === "workspace") {
        return "workspace";
      }
      if (bucket === "exports") {
        return "export";
      }
      if (bucket === "sandbox" || bucket === "transient") {
        return "transient";
      }
      if (bucket === "visualizations") {
        return "session";
      }
    }
    return "session";
  }

  return "transient";
}
