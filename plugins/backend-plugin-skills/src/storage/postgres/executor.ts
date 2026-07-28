export interface SkillsPostgresQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface SkillsPostgresExecutor extends SkillsPostgresQueryExecutor {
  transaction<T>(operation: (executor: SkillsPostgresExecutor) => Promise<T>): Promise<T>;
}
