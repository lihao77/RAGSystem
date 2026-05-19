# Event Bus 实用优化计划

> 创建时间：2026-05-18  
> 修订时间：2026-05-19
> 状态：Phase 1 已实施（Step 1-4），Phase 2 待观测数据

## 目标

这次优化的目标不是把 Event Bus 改造成消息队列或异步 broker，而是在不改变现有行为语义的前提下，降低高频事件路径上的稳定开销，并补上观测能力。

必须保持以下不变量：

- 同一 run 内事件按发布顺序被投递
- 订阅者仍按 priority 从高到低执行
- `RUN_END` / `SESSION_END` 等终止事件不能抢在已入队的普通事件前导致前端提前结束
- `event_to_client_dict` 输出字段保持兼容
- handler 异常只影响对应订阅者，不中断其他订阅者

## 当前工作流

Event Bus 当前是进程内同步事件分发器，不是独立队列服务。

1. 执行入口为每个 run 创建独立 `EventBus`，实际代码路径是 `backend-fastapi/agents/events/session_manager.py` 和 `backend-fastapi/execution/adapters/agent_execution.py`。
2. run 启动阶段注册订阅者，包括：
   - `StepProjector`：监听原始事件，生成 `execution.step`
   - `StreamPersistenceHandler`：写入 messages / run_steps
   - WS/SSE adapter：转发给前端
   - metrics collector 等其他观察者
3. Agent 通过 `EventPublisher._publish()` 创建 `Event`，然后同步调用 `event_bus.publish(event)`。
4. `EventBus.publish()` 记录统计/历史，执行 `RUN_END` side effect，收集订阅者，并按 priority 同步调用 handler。
5. 部分 handler 会在处理过程中再次发布事件，例如 `StepProjector` 会把 raw event 投影成 `execution.step` 再发布回同一个 bus。
6. 前端主要通过 WS 消费事件：`output.chunk` 追加内容，`execution.step` 更新执行树，`run.end` 结束当前 run。

因此，优化重点应放在订阅收集、轻量判断、序列化和背压策略上，避免改变同步分发和事件顺序语义。

## 修改文件

| 文件 | 改动 |
|------|------|
| `backend-fastapi/agents/events/bus.py` | 订阅收集缓存、慢 handler 观测 |
| `backend-fastapi/agents/events/sse_adapter.py` | critical 类型预计算、兼容版 payload 构建、保持 FIFO 的背压优化 |
| `backend-fastapi/api/v1/ws.py` | 视情况复用 critical 类型预计算；背压策略保持 FIFO |
| `backend-fastapi/agents/tests/test_core/test_event_bus.py` | 缓存失效、优先级顺序、慢 handler 观测测试 |
| `backend-fastapi/agents/tests/test_core/test_sse_adapter.py` | critical 判断、FIFO 背压、payload 兼容测试 |
| `backend-fastapi/agents/tests/test_core/test_ws_api.py` | 如调整 WS 背压，补充对应顺序测试 |

## Phase 1：低风险优化，优先实施

### Step 1：`_collect_subscriptions` 缓存（P0）

当前每次 publish 都会合并具体订阅和通配符订阅，并执行去重、排序。订阅通常只在 run 启动/结束阶段变化，高频 publish 时订阅集合基本稳定，适合缓存。

实现要点：

- `EventBus.__init__` 新增：

```python
self._subscription_cache: dict[str, list[Subscription]] = {}
```

- `subscribe()` / `subscribe_all()` / `unsubscribe()` 成功改变订阅集合后调用内部方法：

```python
def _invalidate_subscription_cache(self) -> None:
    self._subscription_cache.clear()
```

- `_collect_subscriptions(event_type)` 使用 normalized event type 作为 key。
- 缓存值必须是已经按 priority 排序并去重后的 `list[Subscription]`。
- 失效逻辑必须在同一把 `_lock` 内完成，避免并发 publish 看到陈旧订阅集合。

不要引入单独的 `_cache_version`，除非后续确实需要调试或统计。当前只清空 dict 更直接。

必须补测试：

- subscribe 后能命中新增订阅
- unsubscribe 后不再投递已移除订阅
- `subscribe_all()` 通配符订阅参与缓存
- priority 顺序保持不变
- handler 内 nested publish 仍正常工作

### Step 2：critical event 类型预计算（P0）

`is_critical_event_type()` 的字符串分支可以从线性扫描改成 set 查询。

实现要点：

```python
_CRITICAL_EVENT_VALUES: frozenset[str] = frozenset(e.value for e in CRITICAL_EVENT_TYPES)
```

字符串分支：

```python
if isinstance(event_type, str):
    return event_type in _CRITICAL_EVENT_VALUES
```

保持 enum 分支兼容：

```python
if event_type in CRITICAL_EVENT_TYPES:
    return True
```

### Step 3：`event_to_client_dict` 兼容版条件构建（P1）

可以减少“先构建完整字典再过滤 None”的额外遍历，但不能改变输出 schema。

当前行为是过滤 `None`，不删除 `False`、`0`、空字符串、`EventPriority.NORMAL.value`。优化后也必须保持：

- `priority` 仍然输出
- `requires_user_action: false` 仍然输出
- `data` 始终输出
- `seq` 始终输出
- 只有值为 `None` 的字段才省略

推荐写法：

```python
def event_to_client_dict(event: Event) -> dict:
    d = {
        "type": event.type.value if hasattr(event.type, "value") else str(event.type),
        "event_id": event.event_id,
        "timestamp": event.timestamp,
        "priority": event.priority.value if hasattr(event.priority, "value") else event.priority,
        "data": build_client_event_data(
            event.type.value if hasattr(event.type, "value") else str(event.type),
            event.data,
        ),
        "requires_user_action": event.requires_user_action,
        "seq": event.sequence_number,
    }
    if event.session_id is not None:
        d["session_id"] = event.session_id
    if event.trace_id is not None:
        d["trace_id"] = event.trace_id
    if event.span_id is not None:
        d["span_id"] = event.span_id
    if event.agent_name is not None:
        d["agent_name"] = event.agent_name
    if event.call_id is not None:
        d["call_id"] = event.call_id
    if event.parent_call_id is not None:
        d["parent_call_id"] = event.parent_call_id
    if event.user_action_timeout is not None:
        d["user_action_timeout"] = event.user_action_timeout
    return d
```

必须补测试：

- normal priority 仍在 payload 中
- `requires_user_action=False` 仍在 payload 中
- `None` 字段不输出
- string event type 不崩溃

### Step 4：慢 handler 观测（P1）

在没有真实数据前，不应优先做大规模并发化。更实用的是先记录慢 handler。

实现要点：

- 在 `EventBus.__init__` 增加可配置阈值，默认例如 `slow_handler_threshold_ms=20`。
- `publish()` 和 `publish_async()` 对每个 handler 计时。
- 超过阈值时打 warning，包含：
  - event type
  - subscription id
  - handler 名称
  - elapsed ms
- 不改变异常处理和投递顺序。

这能定位真正瓶颈：DB 写入、StepProjector 二次发布、WS/SSE 入队、JSON 序列化，还是某个业务 handler。

## Phase 2：背压优化，必须保持 FIFO

### Step 5：SSE 背压优化（P1，重写原双队列方案）

不要使用“critical queue 优先消费 + normal queue 次优先”的双队列方案。它会改变事件发送顺序，可能导致 `run.end` 抢在已入队的 `output.chunk` 前发送，前端提前 finalize run。

推荐方案：单队列、保持 FIFO，只在队满时驱逐最旧的非关键事件。

实现方向：

- 可继续使用 `queue.Queue`，但优化 `_evict_non_critical()` 的扫描范围，例如最多扫描 `min(10, qsize)` 个元素，而不是 drain 全队列。
- 或改成 `collections.deque(maxlen=None)` + `threading.Condition` / `threading.Event`，但仍必须单队列 FIFO。
- 队满时：
  - 如果新事件是非关键事件：丢弃新事件，递增 `_dropped_count`
  - 如果新事件是关键事件：从队头向后找一个非关键事件移除，再把关键事件放到队尾
  - 如果队列全是关键事件：记录 warning，不破坏顺序
- `stream_sync()` 始终从同一队列头部取事件。
- `stop()` 的哨兵唤醒语义必须保留。

必须补测试：

- buffer 满时关键事件不会因为普通事件被丢弃
- 已在队列中的普通事件不会被后来的关键事件越过
- `run.end` 不会抢先导致前面的普通事件丢失
- `_dropped_count` 对所有丢弃路径都递增
- `stop()` 能唤醒阻塞中的 `stream_sync()`

### Step 6：WS 背压策略对齐（P2）

WS 当前也有 `_evict_non_critical()`，但已限制扫描最多 10 个元素。除非观测证明这里是瓶颈，否则不要优先改。

如果调整，必须和 SSE 一样保持 FIFO，不引入 critical 优先消费。

## 暂不实施

### `publish_async` 全量并发化

暂不把 `publish_async` 改成“sync handlers 先跑、async handlers 再 gather”。这会改变 priority 语义：高优先级 async handler 可能被低优先级 sync handler 反超。

如果未来确实需要优化 async handler，必须采用更保守的方案：

- 保持 priority 从高到低的分组顺序
- 只允许同一 priority 内的 async handler 并发
- 同一 priority 组完成后再进入下一组
- 明确测试异常统计和执行顺序

当前 `publish_async` 使用频率不高，收益不值得先承担行为风险。

### `RUN_END` side effect 改成普通订阅

暂不改。

当前 `_handle_run_end_side_effect()` 在订阅者执行前运行，并吞掉异常。改成普通订阅会改变清理时机、priority 关系和 failed delivery 统计语义。这个函数目前逻辑很轻，而且 `mark_run_ended()` 当前是 no-op，优化收益很小。

如果后续确实要改，需要：

- 明确内部订阅 priority 高于业务订阅
- 保持异常吞掉或明确改变错误统计
- 补充 RUN_END 清理顺序测试

### Event 对象轻量化

暂不改 UUID、timestamp、dataclass 结构。影响面大，收益需要 profile 支撑。

### 事件合并 / 节流

暂不在 EventBus 层做。`output.chunk`、`intent_delta`、`execution.step` 的合并属于前端体验和应用层协议问题，不能在 bus 核心层静默改变。

### orjson 替代 json.dumps

暂不引入新依赖。若观测显示序列化是瓶颈，再单独评估。

## 建议实施顺序

1. 实施 Step 1：订阅缓存
2. 实施 Step 2：critical set 预计算
3. 实施 Step 3：兼容版 payload 构建
4. 实施 Step 4：慢 handler 观测
5. 跑测试并进行一次真实对话观察日志
6. 只有在确认 SSE 背压是瓶颈后，再实施 Step 5
7. WS 背压和 `publish_async` 并发化放到后续单独评估

## 验证

从 `backend-fastapi/` 目录运行：

```bash
pytest agents/tests/test_core/test_event_bus.py -v
pytest agents/tests/test_core/test_sse_adapter.py -v
pytest agents/tests/test_core/test_ws_api.py -v
```

集成验证：

```bash
python main.py
```

通过前端发起一次普通对话和一次包含工具调用的对话，确认：

- token/chunk 顺序正常
- 执行树正常更新
- final answer 不丢失
- `run.end` 后 UI 正常结束 loading
- 日志中没有异常的 failed delivery
- 慢 handler warning 可用于定位真实瓶颈
