import path from "node:path";

export function isPathUnder(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isAbsolutePathLike(value: string): boolean {
  return path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

export function resolvePathLike(value: string): string {
  if (process.platform !== "win32" && /^[a-zA-Z]:[\\/]/.test(value)) {
    return value.replace(/\//g, "\\");
  }
  return path.resolve(value);
}
