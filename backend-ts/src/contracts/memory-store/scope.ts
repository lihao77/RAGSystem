/** 将 workspace 标识转换成稳定的 memory scope key。 */
export function getWorkspaceMemoryKey(workspaceRoot: string | null): string | null {
  if (!workspaceRoot) return null;
  const raw = workspaceRoot.trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/\\/g, "-")
    .replace(/\//g, "-")
    .replace(/:/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return normalized || "workspace";
}
