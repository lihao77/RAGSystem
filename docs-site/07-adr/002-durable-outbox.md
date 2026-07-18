# ADR-002：Durable Outbox 作为客户端事件出口

## 决策

客户端事件先持久化到 conversation store 的 outbox，再由 dispatcher 发布到 realtime hub 和 WebSocket/SSE。

## 原因

网络断开、进程重启和慢客户端不能丢失 run 终态或造成前端状态倒退。

## 约束

事件必须带稳定类型和单调序号；客户端按序号去重和恢复，不按到达时间排序。
