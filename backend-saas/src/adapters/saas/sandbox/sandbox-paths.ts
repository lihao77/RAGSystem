export type SandboxFileSpace = "uploads" | "workspace" | "artifacts" | "transient";

export interface ResolvedSandboxPath {
  internalPath: string;
  displayPath: string;
  space: SandboxFileSpace;
  writable: boolean;
}

const ROOTS: Record<SandboxFileSpace, string> = {
  uploads: "/input/uploads",
  workspace: "/work",
  artifacts: "/input/artifacts",
  transient: "/work/transient",
};

const SPACE_ALIASES = new Map<string, SandboxFileSpace>([
  ["input", "uploads"],
  ["uploads", "uploads"],
  ["work", "workspace"],
  ["workspace", "workspace"],
  ["artifacts", "artifacts"],
  ["transient", "transient"],
]);

export function resolveSandboxPath(
  rawPath: string | null | undefined,
  input: { explicitSpace?: string | null | undefined; operation: "read" | "write" | "search"; defaultName?: string | undefined },
): ResolvedSandboxPath {
  const requested = rawPath?.trim().replace(/\\/g, "/") || input.defaultName || "";
  rejectUnsafePath(requested);
  const parts = requested.split("/").filter((part) => part && part !== ".");
  const explicitSpace = normalizeSpace(input.explicitSpace);
  const prefixedSpace = explicitSpace ? null : SPACE_ALIASES.get(parts[0]?.toLowerCase() ?? "") ?? null;
  const space = explicitSpace ?? prefixedSpace ?? "workspace";
  if (prefixedSpace) parts.shift();
  if (input.operation !== "search" && parts.length === 0) throw new Error("文件路径不能为空");
  if (input.operation === "write" && (space === "uploads" || space === "artifacts")) throw new Error(`${space} 是只读空间，禁止写入`);
  const relativePath = parts.join("/");
  return {
    internalPath: relativePath ? `${ROOTS[space]}/${relativePath}` : ROOTS[space],
    displayPath: relativePath ? `${space}/${relativePath}` : space,
    space,
    writable: space !== "uploads" && space !== "artifacts",
  };
}

export function validateSandboxGlob(pattern: string): string {
  const normalized = pattern.trim().replace(/\\/g, "/");
  if (!normalized) throw new Error("pattern 不能为空");
  rejectUnsafePath(normalized);
  return normalized;
}

function normalizeSpace(value: string | null | undefined): SandboxFileSpace | null {
  if (!value?.trim()) return null;
  const space = SPACE_ALIASES.get(value.trim().toLowerCase());
  if (!space) throw new Error(`不支持的沙箱文件空间: ${value}`);
  return space;
}

function rejectUnsafePath(value: string): void {
  if (!value) return;
  if (value.startsWith("/") || /^[A-Za-z]:($|\/)/.test(value) || value.startsWith("//")) {
    throw new Error("沙箱工具不接受绝对路径");
  }
  if (value.split("/").some((part) => part === "..")) {
    throw new Error("路径不能包含 .. 越界片段");
  }
  if (value.includes("\0")) throw new Error("路径不能包含 NUL 字符");
}
