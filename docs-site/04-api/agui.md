# AG-UI

`POST /api/agui` 由 `backend-ts/src/routes/agent/agui.ts` 注册，调用 `services/agui-gateway` 完成输入校验、事件翻译、SSE 流和 interrupt。AG-UI 是对外网关，不替代 `@ragsystem/agent-protocol` 内部事件定义。

Widget 身份启用时，AG-UI 使用 Widget identity；普通租户使用 session identity。
