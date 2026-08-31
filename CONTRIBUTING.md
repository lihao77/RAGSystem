# Contributing

感谢你对 RAGSystem 的关注。

## 开发环境 / Development setup

1. 准备 Node.js 22.5+ 和 npm。
2. 在仓库根目录执行 `npm ci`，并按 [README.md](README.md) 配置 `backend-local/.env` 与 `frontend-client/.env`。
3. 启动后端：`npm run dev:backend-local`（SaaS 入口为 `npm run dev:backend-saas`）
4. 启动前端：`cd frontend-client && npm run dev`

## 提交前检查 / Before opening a PR

请至少运行以下命令：

```bash
npm run check:packages
npm run check:backend
npm run check:frontend
npm run check:widget
```

## 文档同步 / Documentation updates

- 修改系统行为时，请同步更新对应架构文档。
- 根 README 保持总览，详细设计请写入 `docs/` 或子目录文档。
- 不要提交真实密钥、令牌、内网地址或本地临时产物。

## 数据迁移与形态归一 / Data hydration discipline

1. 任何持久化数据形状的变更，必须在同一次变更里带上加载时的水合/归一逻辑——只改写入端不改读取端，会制造只在存量部署处爆发的失效引用。
2. 迁移逻辑必须幂等且由数据形状驱动（不看版本号），保证跳版升级、备份恢复、手工编辑后的半迁移状态都能收敛。全量清单见 `backend-core/MIGRATIONS.md`；新增或退役任何步骤必须同步登记该文件（`backend-core/test/hydration-manifest.test.ts` 会校验代码中注册的步骤 id 均已登记）。
3. 区分两类步骤：可退役迁移（登记 MIGRATIONS.md，保留到宣布最低支持版本为止，实际生效时由持久层记录应用戳）与永久形态归一层（同时服务新建/更新路径，永不退役、无应用戳）。新步骤挂在所属存储的 hydration 模块（如 `backend-core/src/services/agent/config/agent-config-hydration.ts`、`backend-core/src/services/integrations/model-adapter-hydration.ts`），不要在业务 service 里另起炉灶。
4. 修数据形状相关的 bug 时，在测试里放各历史形状的夹具并断言收敛到当前形态，防止后人无意删断迁移链。
5. 会话 team 快照只是身份记录，执行期 Agent 配置（含 llm_tiers 引用）每次运行实时解析；引用解析不到时明确报缺失，不做静默兜底。系统内置 Agent 不写死示例 LLM tier，无 tier 时继承系统 LLM。

## Pull Request 建议 / Pull request guidance

- 说明变更动机与影响范围。
- 描述你执行过的验证步骤。
- 如果涉及 UI 或交互变更，请附截图或录屏。
