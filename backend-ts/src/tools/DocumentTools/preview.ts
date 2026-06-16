import fs from "node:fs";
import path from "node:path";

import { parse as parseYaml } from "yaml";

export const DEFAULT_STRUCTURE_PREVIEW_ROWS = 5;
export const DEFAULT_STRUCTURE_PREVIEW_DEPTH = 3;
export const DEFAULT_STRUCTURE_PREVIEW_FIELDS = 20;

const WKT_PATTERN = /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*\(/i;
const GEOJSON_TYPES = new Set([
  "FeatureCollection",
  "Feature",
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

type PreviewRecord = Record<string, unknown>;

export function readPreviewLimit(
  value: number | null | undefined,
  fallback: number,
  label: "max_preview_rows" | "max_depth" | "max_fields",
): { value: number } | { error: string } {
  if (value === null || value === undefined) {
    return { value: fallback };
  }
  if (!Number.isInteger(value) || value < 1) {
    return { error: `${label} 必须 >= 1` };
  }
  return { value };
}

export function buildDataStructurePreview(
  filePath: string,
  input: {
    encoding: BufferEncoding;
    maxPreviewRows: number;
    maxDepth: number;
    maxFields: number;
  },
): { fileType: string; structure: PreviewRecord } {
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === ".json" || suffix === ".yaml" || suffix === ".yml") {
    const data = loadStructuredDocument(filePath, input.encoding);
    return {
      fileType: suffix.slice(1),
      structure: previewDataValue(data, {
        maxDepth: input.maxDepth,
        maxFields: input.maxFields,
        sampleSize: input.maxPreviewRows,
      }),
    };
  }

  if (suffix === ".csv" || suffix === ".tsv") {
    const delimiter = suffix === ".tsv" ? "\t" : detectCsvDelimiter(filePath, input.encoding, ",");
    return {
      fileType: delimiter === "\t" ? "tsv" : "csv",
      structure: previewDelimitedFile(filePath, {
        encoding: input.encoding,
        delimiter,
        maxRows: input.maxPreviewRows,
      }),
    };
  }

  return {
    fileType: suffix ? suffix.slice(1) : "text",
    structure: previewTextFile(filePath, {
      encoding: input.encoding,
      maxRows: input.maxPreviewRows,
    }),
  };
}

function loadStructuredDocument(filePath: string, encoding: BufferEncoding): unknown {
  const content = fs.readFileSync(filePath).toString(encoding);
  const suffix = path.extname(filePath).toLowerCase();
  if (suffix === ".json") {
    return JSON.parse(content);
  }
  if (suffix === ".yaml" || suffix === ".yml") {
    return parseYaml(content) ?? null;
  }
  throw new Error(`不支持的结构化文档格式: ${suffix}`);
}

function previewDataValue(
  value: unknown,
  input: {
    depth?: number;
    maxDepth: number;
    maxFields: number;
    sampleSize: number;
  },
): PreviewRecord {
  const depth = input.depth ?? 0;
  if (isRecord(value) && isGeoJson(value)) {
    return previewGeoJson(value, input.sampleSize);
  }

  if (depth >= input.maxDepth) {
    if (isRecord(value)) {
      return {
        type: "object",
        key_count: Object.keys(value).length,
        truncated: true,
      };
    }
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        truncated: true,
      };
    }
    return previewScalar(value);
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    const fields: Record<string, PreviewRecord> = {};
    for (const key of keys.slice(0, input.maxFields)) {
      fields[key] = previewDataValue(value[key], {
        ...input,
        depth: depth + 1,
      });
    }
    const result: PreviewRecord = {
      type: "object",
      key_count: keys.length,
      keys: keys.slice(0, input.maxFields),
      fields,
    };
    if (keys.length > input.maxFields) {
      result.truncated_keys = keys.length - input.maxFields;
    }
    return result;
  }

  if (Array.isArray(value)) {
    const sampleItems = value.slice(0, input.sampleSize);
    const itemTypes = [...new Set(sampleItems.map((item) => arrayItemTypeName(item)))].sort();
    const result: PreviewRecord = {
      type: "array",
      length: value.length,
      item_types: itemTypes,
      sample_item_count: sampleItems.length,
    };

    if (!sampleItems.length) {
      return result;
    }

    if (sampleItems.every(isRecord)) {
      const summaries = new Map<string, { types: Set<string>; presentIn: number; example: unknown }>();
      const fieldOrder: string[] = [];
      for (const item of sampleItems) {
        for (const [rawKey, itemValue] of Object.entries(item)) {
          const key = String(rawKey);
          if (!summaries.has(key)) {
            if (fieldOrder.length >= input.maxFields) {
              continue;
            }
            fieldOrder.push(key);
            summaries.set(key, {
              types: new Set<string>(),
              presentIn: 0,
              example: undefined,
            });
          }
          const summary = summaries.get(key);
          if (!summary) {
            continue;
          }
          summary.types.add(fieldTypeName(itemValue));
          summary.presentIn += 1;
          if (summary.example === undefined) {
            summary.example = previewFieldExample(itemValue, {
              ...input,
              depth: depth + 1,
            });
          }
        }
      }

      const fields: Record<string, PreviewRecord> = {};
      for (const [key, summary] of summaries.entries()) {
        fields[key] = {
          types: [...summary.types].sort(),
          present_in_sample: summary.presentIn,
          example: summary.example,
        };
      }
      const itemStructure: PreviewRecord = {
        type: "object",
        fields,
      };
      if (fieldOrder.length >= input.maxFields) {
        itemStructure.truncated_fields = true;
      }
      result.item_structure = itemStructure;
      return result;
    }

    result.sample_items = sampleItems.map((item) =>
      previewDataValue(item, {
        ...input,
        depth: depth + 1,
      }),
    );
    return result;
  }

  return previewScalar(value);
}

function previewFieldExample(
  value: unknown,
  input: {
    depth: number;
    maxDepth: number;
    maxFields: number;
    sampleSize: number;
  },
): unknown {
  if (isRecord(value) && isGeoJson(value)) {
    return previewGeoJson(value, input.sampleSize);
  }
  if (isRecord(value) || Array.isArray(value)) {
    return previewDataValue(value, input);
  }
  const scalar = previewScalar(value);
  return scalar.type === "wkt_geometry" ? scalar : scalar.example ?? value;
}

function previewDelimitedFile(
  filePath: string,
  input: {
    encoding: BufferEncoding;
    delimiter: string;
    maxRows: number;
  },
): PreviewRecord {
  const content = fs.readFileSync(filePath).toString(input.encoding);
  const lines = splitTextLines(content);
  const fieldnames = lines.length ? parseDelimitedLine(lines[0]!, input.delimiter) : [];
  const sampleRows: Array<Record<string, string>> = [];
  let totalRows = 0;

  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }
    const values = parseDelimitedLine(line, input.delimiter);
    totalRows += 1;
    if (sampleRows.length < input.maxRows) {
      const row: Record<string, string> = {};
      for (const [index, field] of fieldnames.entries()) {
        row[field] = values[index] ?? "";
      }
      sampleRows.push(row);
    }
  }

  return {
    root_type: "table",
    delimiter: input.delimiter,
    column_count: fieldnames.length,
    columns: fieldnames,
    sample_row_count: sampleRows.length,
    total_rows: totalRows,
    column_types: inferCsvColumnTypes(sampleRows, fieldnames),
    sample_rows: sampleRows,
  };
}

function previewTextFile(
  filePath: string,
  input: {
    encoding: BufferEncoding;
    maxRows: number;
  },
): PreviewRecord {
  const content = fs.readFileSync(filePath).toString(input.encoding);
  const lines = splitTextLines(content);
  const lineLengths = lines.map((line) => line.length);
  const totalLength = lineLengths.reduce((sum, value) => sum + value, 0);
  return {
    root_type: "text",
    total_lines: lines.length,
    non_empty_lines: lines.filter((line) => line.trim()).length,
    max_line_length: Math.max(0, ...lineLengths),
    average_line_length: lines.length ? Math.round((totalLength / lines.length) * 100) / 100 : 0,
    preview_lines: lines.slice(0, input.maxRows),
  };
}

function detectCsvDelimiter(filePath: string, encoding: BufferEncoding, fallback: string): string {
  const sample = fs.readFileSync(filePath).toString(encoding).slice(0, 2048);
  if (!sample.trim()) {
    return fallback;
  }
  const lines = splitTextLines(sample).filter((line) => line.trim()).slice(0, 5);
  const candidates = [",", "\t", ";", "|"];
  let bestDelimiter = fallback;
  let bestScore = 0;
  for (const delimiter of candidates) {
    const counts = lines.map((line) => countDelimiterOutsideQuotes(line, delimiter));
    const positiveCounts = counts.filter((count) => count > 0);
    if (!positiveCounts.length) {
      continue;
    }
    const first = positiveCounts[0]!;
    const consistency = positiveCounts.filter((count) => count === first).length;
    const score = consistency * 100 + positiveCounts.reduce((sum, count) => sum + count, 0);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }
  return bestDelimiter;
}

function inferCsvColumnTypes(
  sampleRows: Array<Record<string, string>>,
  fieldnames: string[],
): Record<string, PreviewRecord> {
  const result: Record<string, PreviewRecord> = {};
  for (const field of fieldnames) {
    const observedTypes = new Set<string>();
    const examples: string[] = [];
    let nonEmptyCount = 0;
    for (const row of sampleRows) {
      const rawValue = (row[field] ?? "").trim();
      if (!rawValue) {
        continue;
      }
      nonEmptyCount += 1;
      if (examples.length < 2) {
        examples.push(truncatePreviewText(rawValue));
      }
      observedTypes.add(inferCsvScalarType(rawValue));
    }
    result[field] = {
      types: observedTypes.size ? [...observedTypes].sort() : ["string"],
      non_empty_in_sample: nonEmptyCount,
      examples,
    };
  }
  return result;
}

function inferCsvScalarType(value: string): string {
  const lowered = value.toLowerCase();
  if (lowered === "true" || lowered === "false") {
    return "boolean";
  }
  if (/^[+-]?\d+$/.test(value)) {
    return "integer";
  }
  if (value.trim() !== "" && Number.isFinite(Number(value))) {
    return "number";
  }
  return "string";
}

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
}

function countDelimiterOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
        continue;
      }
      quoted = !quoted;
      continue;
    }
    if (char === delimiter && !quoted) {
      count += 1;
    }
  }
  return count;
}

function splitTextLines(content: string): string[] {
  if (!content) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function isRecord(value: unknown): value is PreviewRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGeoJson(value: PreviewRecord): boolean {
  const type = typeof value.type === "string" ? value.type : null;
  return Boolean(type && GEOJSON_TYPES.has(type));
}

function previewGeoJson(value: PreviewRecord, sampleSize = 3): PreviewRecord {
  const geojsonType = typeof value.type === "string" ? value.type : "";
  if (geojsonType === "FeatureCollection") {
    const features = Array.isArray(value.features) ? value.features.filter(isRecord) : [];
    const geometryTypes: Record<string, number> = {};
    let totalCoordinates = 0;
    let mergedBbox: number[] | null = null;
    for (const feature of features) {
      const geometry = isRecord(feature.geometry) ? feature.geometry : {};
      const geometryType = typeof geometry.type === "string" ? geometry.type : "null";
      geometryTypes[geometryType] = (geometryTypes[geometryType] ?? 0) + 1;
      totalCoordinates += countCoordinates(geometry.coordinates);
      const bbox = bboxFromCoordinates(geometry.coordinates);
      if (bbox) {
        mergedBbox = mergeBbox(mergedBbox, bbox);
      }
    }

    const propertiesFields: string[] = [];
    const sampleProperties: PreviewRecord[] = [];
    for (const feature of features.slice(0, sampleSize)) {
      const properties = isRecord(feature.properties) ? feature.properties : {};
      if (!propertiesFields.length) {
        propertiesFields.push(...Object.keys(properties).slice(0, DEFAULT_STRUCTURE_PREVIEW_FIELDS));
      }
      const sampled: PreviewRecord = {};
      for (const [key, propertyValue] of Object.entries(properties).slice(0, 8)) {
        if (isRecord(propertyValue) || Array.isArray(propertyValue)) {
          continue;
        }
        if (typeof propertyValue === "string" && propertyValue.length > 60) {
          sampled[key] = isWktGeometry(propertyValue) ? previewWkt(propertyValue) : truncatePreviewText(propertyValue, 80);
        } else {
          sampled[key] = propertyValue;
        }
      }
      sampleProperties.push(sampled);
    }

    const result: PreviewRecord = {
      type: "geojson",
      geojson_type: "FeatureCollection",
      feature_count: features.length,
      geometry_types: geometryTypes,
      total_coordinates_estimate: totalCoordinates,
      properties_fields: propertiesFields,
    };
    const bbox = normalizeBbox(value.bbox) ?? mergedBbox;
    if (bbox) {
      result.bbox = bbox.map(roundCoordinate);
    }
    if (sampleProperties.length) {
      result.sample_properties = sampleProperties;
    }
    return result;
  }

  if (geojsonType === "Feature") {
    const geometry = isRecord(value.geometry) ? value.geometry : {};
    const properties = isRecord(value.properties) ? value.properties : {};
    return {
      type: "geojson",
      geojson_type: "Feature",
      ...previewGeometry(geometry),
      properties_fields: Object.keys(properties).slice(0, DEFAULT_STRUCTURE_PREVIEW_FIELDS),
    };
  }

  return {
    type: "geojson",
    ...previewGeometry(value),
  };
}

function previewGeometry(geometry: PreviewRecord): PreviewRecord {
  const result: PreviewRecord = {
    geometry_type: typeof geometry.type === "string" ? geometry.type : "unknown",
    coordinate_count: countCoordinates(geometry.coordinates),
  };
  const bbox = normalizeBbox(geometry.bbox) ?? bboxFromCoordinates(geometry.coordinates);
  if (bbox) {
    result.bbox = bbox.map(roundCoordinate);
  }
  return result;
}

function countCoordinates(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) {
    return 0;
  }
  if (typeof value[0] === "number") {
    return 1;
  }
  return value.reduce((sum, item) => sum + countCoordinates(item), 0);
}

function bboxFromCoordinates(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (typeof value[0] === "number") {
    const x = Number(value[0]);
    const y = typeof value[1] === "number" ? Number(value[1]) : 0;
    return [x, y, x, y];
  }
  let bbox: number[] | null = null;
  for (const item of value) {
    const itemBbox = bboxFromCoordinates(item);
    if (itemBbox) {
      bbox = mergeBbox(bbox, itemBbox);
    }
  }
  return bbox;
}

function mergeBbox(current: number[] | null, next: number[]): number[] {
  if (!current) {
    return [...next];
  }
  return [
    Math.min(current[0]!, next[0]!),
    Math.min(current[1]!, next[1]!),
    Math.max(current[2]!, next[2]!),
    Math.max(current[3]!, next[3]!),
  ];
}

function normalizeBbox(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 4 || !value.slice(0, 4).every((item) => typeof item === "number")) {
    return null;
  }
  return value.slice(0, 4).map(Number);
}

function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fieldTypeName(value: unknown): string {
  if (isRecord(value) && isGeoJson(value)) {
    return "geojson";
  }
  if (isRecord(value)) {
    return "object";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "string" && value.length > 30 && isWktGeometry(value)) {
    return "wkt_geometry";
  }
  return scalarTypeName(value);
}

function arrayItemTypeName(value: unknown): string {
  if (isRecord(value)) {
    return "object";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return scalarTypeName(value);
}

function scalarTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (value === undefined) {
    return "undefined";
  }
  return (value as { constructor?: { name?: string } }).constructor?.name ?? typeof value;
}

function previewScalar(value: unknown): PreviewRecord {
  if (typeof value === "string" && value.length > 30 && isWktGeometry(value)) {
    return previewWkt(value);
  }
  const preview: PreviewRecord = {
    type: scalarTypeName(value),
  };
  if (typeof value === "string") {
    preview.example = truncatePreviewText(value);
    preview.length = value.length;
  } else if (value !== null && value !== undefined) {
    preview.example = value;
  }
  return preview;
}

function isWktGeometry(value: string): boolean {
  return WKT_PATTERN.test(value);
}

function previewWkt(value: string): PreviewRecord {
  const match = WKT_PATTERN.exec(value);
  const rawType = match?.[1] ?? "Unknown";
  return {
    type: "wkt_geometry",
    geometry_type: rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase(),
    length: value.length,
    example: value.length > 60 ? `${value.slice(0, 60)}...` : value,
  };
}

function truncatePreviewText(value: string, limit = 120): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}
