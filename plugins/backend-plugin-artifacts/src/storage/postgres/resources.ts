export interface ArtifactQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number;
}

export interface ArtifactPostgresExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<ArtifactQueryResult<Row>>;
  transaction<T>(operation: (executor: ArtifactPostgresExecutor) => Promise<T>): Promise<T>;
}

export interface ArtifactObjectStorage {
  put(key: string, body: Uint8Array, contentType?: string | null): Promise<unknown>;
  get(key: string): Promise<{ body: Uint8Array } | null>;
  delete(key: string): Promise<boolean>;
}
