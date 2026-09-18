# Goal 的暂停、恢复与中断消息

用户停止会话时，公共 `stopSession` 入口先把当前 active Goal 持久化为 paused，保留计划、检查点和进度，再中断运行。HTTP、WebSocket、AG-UI 和 Goal 面板的暂停操作共用该入口。两轮运行之间也可以停止 Goal；重复停止不会生成重复状态消息。

## 状态感知

有前台运行时，暂停结果通过中断原因传给已有终态落库路径，在同一条 `run_terminal` assistant 消息里追加“目标「…」已暂停，已有进度已保留”。保留已输出的思考和部分正文，Run 仍为 interrupted，不额外请求模型。游离/挂起运行的存储中断路径使用相同消息构造器。

没有根运行可收尾时，记录一条 assistant 状态变化消息。通过界面恢复时同样记录一次恢复消息；消息 ID 由 Goal ID、代次和状态决定。消息直接进入历史，不投递到会自动唤醒 Agent 的 mailbox。正常调用模型不会重复添加 Goal 提示。

压缩摘要的当前状态部分须保留最新 Goal 状态及用户暂停/恢复决定，以最后一次状态变化或工具结果为准。智能体不确定状态时可调用 `goal_get`。

## 工具规则

- `goal_update` 未传 status 时只更新内容，维持 paused 等现有状态；返回实际 status 和自动续跑是否开启。
- 智能体可以在新的用户交互中显式设置 active。查询进度或修改计划本身不表示恢复。
- 后台通知运行、自动 Goal 续跑及子运行不能解除暂停。新用户交互的根运行可以恢复。
- completed/blocked 的既有约束保持；blocked 的显式重开仍会重置循环保护预算。

## 并发与旧请求

复用已有 `continuation_generation`：生命周期状态变化和续跑认领都会推进代次；普通进度更新不推进。每个运行在启动时由后端读取一次当前 Goal ID/代次，工具成功变更状态后更新自己持有的代次。`goal_get` 不刷新运行的写入凭据，避免旧执行通过重读绕过用户停止。

工具写入由 SQLite 事务/Postgres 行锁保护，在锁内检查预期代次和取消信号。不需要新增数据库字段，也没有需要迁移的持久化数据形状。历史 Goal 沿用既有代次即可；旧队列行缺少有效身份或代次时按失效处理。

空闲队列消费者与运行中刷新入口都会验证 Goal ID、active 状态和代次，失效行直接 settle。根运行启动事务再次校验作为输入的 Goal 续跑行，防止用户在消费检查之后暂停；暂停后重新开启不会重新消费旧代次。

相关回归：`backend-core/test/goal-interruption.test.ts`、`backend-core/test/idle-notification-mailbox.test.ts`、`backend-local/test/goal-interruption.test.mjs`、`backend-saas/test/goal-interruption.test.mjs`。
