/**
 * 向量存储数据面错误(收编:取代散落在 service 的 KnowledgeBaseError 的数据面职责)。
 *
 * 深合约:driver 抛出携带 statusCode(对应 HTTP 状态码),供路由层统一映射;
 * 非异常的「不存在/无命中」路径返回 null/空数组(深合约风格),只有真正失败(连接断、维度不匹配、
 * I/O 错)才抛本异常。配 vectorizer/reranker 配置面的错误仍用旧的 KnowledgeBaseError。
 */
export class VectorStoreError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "VectorStoreError";
    this.statusCode = statusCode;
  }
}
