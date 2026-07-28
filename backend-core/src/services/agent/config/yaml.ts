import { isRecord } from "../../../utils/guards.js";
export function toYaml(value: unknown): string {
  return `${yamlValue(value, 0)}\n`;
}

function yamlValue(value: unknown, indent: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value.map((item) => yamlArrayItem(item, indent)).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    return entries.map(([key, item]) => yamlObjectEntry(key, item, indent)).join("\n");
  }
  return yamlScalar(value);
}

function yamlObjectEntry(key: string, value: unknown, indent: number): string {
  const prefix = `${" ".repeat(indent)}${key}:`;
  if (Array.isArray(value)) {
    return value.length === 0 ? `${prefix} []` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0 ? `${prefix} {}` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  return `${prefix} ${yamlScalar(value)}`;
}

function yamlArrayItem(value: unknown, indent: number): string {
  const prefix = `${" ".repeat(indent)}-`;
  if (Array.isArray(value)) {
    return value.length === 0 ? `${prefix} []` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  if (isRecord(value)) {
    return Object.keys(value).length === 0 ? `${prefix} {}` : `${prefix}\n${yamlValue(value, indent + 2)}`;
  }
  return `${prefix} ${yamlScalar(value)}`;
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}


