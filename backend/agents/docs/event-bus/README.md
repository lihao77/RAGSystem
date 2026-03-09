# 事件总线文档

当前事件总线实现位于：

- `backend/agents/events/bus.py`
- `backend/agents/events/publisher.py`
- `backend/agents/events/session_manager.py`
- `backend/agents/events/sse_adapter.py`

## 相关接口

- `POST /api/agent/stream`
- `POST /api/agent/stream/reconnect`
- `POST /api/agent/stream/stop`
- `POST /api/agent/sessions/<session_id>/approvals/<approval_id>/respond`
- `POST /api/agent/sessions/<session_id>/inputs/<input_id>/respond`

## 文档

- `EVENT_BUS_INTEGRATION_GUIDE.md`
- `SESSION_EVENT_BUS_GUIDE.md`

## 说明

- 事件总线用于流式执行、审批、输入请求和监控事件分发
- 具体事件类型以 `backend/agents/events/bus.py` 中的 `EventType` 为准
