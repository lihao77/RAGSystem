# 对话持久化 API 文档

## 会话创建
POST `/api/agent/sessions`

请求体：
```json
{
  "session_id": "可选",
  "user_id": "可选",
  "metadata": {}
}
```

响应：
```json
{
  "success": true,
  "data": {
    "session_id": "uuid",
    "user_id": "u1",
    "metadata": {}
  }
}
```

## 会话详情
GET `/api/agent/sessions/{session_id}`

响应：
```json
{
  "success": true,
  "data": {
    "session_id": "uuid",
    "user_id": "u1",
    "metadata": {},
    "created_at": "2026-02-12 10:00:00",
    "updated_at": "2026-02-12 10:10:00"
  }
}
```

## 会话消息分页
GET `/api/agent/sessions/{session_id}/messages?limit=20&offset=0`

响应：
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "seq": 1,
        "id": "msg-id",
        "role": "user",
        "content": "你好",
        "metadata": {},
        "created_at": "2026-02-12 10:01:00"
      }
    ],
    "total": 10,
    "limit": 20,
    "offset": 0,
    "has_more": false
  }
}
```

## 连续对话接口
### 执行任务（非流式）
POST `/api/agent/execute`

请求体：
```json
{
  "task": "问题内容",
  "session_id": "已有会话ID",
  "user_id": "可选",
  "agent": "可选"
}
```

### 流式执行
POST `/api/agent/stream`

请求体：
```json
{
  "task": "问题内容",
  "session_id": "已有会话ID",
  "user_id": "可选",
  "use_v2": true
}
```
