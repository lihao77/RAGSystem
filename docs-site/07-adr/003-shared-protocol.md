# ADR-003：共享协议包作为事件单源

## 决策

`@ragsystem/agent-protocol` 定义 wire envelope、事件、session socket 和执行树；backend、frontend、widget 复用该包。

## 影响

协议变更必须先更新 schema、测试和构建产物，再更新生产者和消费者；不能在前端复制一份事件接口。
