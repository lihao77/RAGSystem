/**
 * Embedder 契约(把文本嵌入向量空间)——对齐 Python `EmbedderBase`,TS 独立设计不复刻签名。
 *
 * 深合约:
 * - embed 批量嵌入文本,返回 number[][](与输入一一对应、顺序保持);单条传 [text]。
 *   实现可内部批量/缓存,对调用方透明。远程 embed I/O 失败(网络/超时/配额)抛异常(非静默 null),
 *   调用方自行处理降级(如 fallback 到 HashEmbedder);
 * - dimension 惰性探测:首次 embed 后缓存真实维度(由模型决定),废弃硬编码 64。
 *   RemoteEmbedder 探测向量长度,HashFallbackEmbedder 固定 64;
 * - key 唯一标识(remote:<provider>/<model> 或 local:hash-64),供 vectorizer 关联与去重;
 * - semantic=false 表示非语义(hash fallback),仅供开发/降级,生产应用真模型。
 */
export interface IEmbedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly key: string;
  readonly semantic: boolean;
}
