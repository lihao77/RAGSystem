export interface KnowledgePostgresQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface KnowledgePostgresExecutor extends KnowledgePostgresQueryExecutor {
  transaction<T>(operation: (executor: KnowledgePostgresExecutor) => Promise<T>): Promise<T>;
}
