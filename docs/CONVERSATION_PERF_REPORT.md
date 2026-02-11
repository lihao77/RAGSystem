# 对话持久化性能测试报告

## 测试方法
- 命令：`python backend/perf_conversation_store.py --sessions 50 --messages-per-session 50`
- 会话数：50
- 单会话消息数：50
- 目标：写入 <100ms，查询 <500ms

## 结果
- write_avg_ms: 81.24
- write_p95_ms: 95.87
- query_ms: 76.71
- items: 20
- total: 50

## 结论
- 写入平均与 P95 均满足 <100ms
- 查询满足 <500ms
