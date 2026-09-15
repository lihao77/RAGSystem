# AI 协作约定

本文件适用于整个仓库。所有文本文件统一使用 UTF-8 编码，中文内容不得转换为其他编码。通用贡献流程见 `CONTRIBUTING.md`。

## 数据迁移与形态归一

1. 任何持久化数据形状的变更，必须在同一次变更里带上加载时的水合/归一逻辑——只改写入端不改读取端，会制造只在存量部署处爆发的失效引用。
2. 迁移逻辑必须幂等且由数据形状驱动（不看版本号），保证跳版升级、备份恢复、手工编辑后的半迁移状态都能收敛。全量清单见 `backend-core/MIGRATIONS.md`；新增或退役任何步骤必须同步登记该文件（`backend-core/test/hydration-manifest.test.ts` 会校验代码中注册的步骤 id 均已登记）。
3. 区分两类步骤：可退役迁移（登记 MIGRATIONS.md，保留到宣布最低支持版本为止，实际生效时由持久层记录应用戳）与永久形态归一层（同时服务新建/更新路径，永不退役、无应用戳）。新步骤挂在所属存储的 hydration 模块（如 `backend-core/src/services/agent/config/agent-config-hydration.ts`、`backend-core/src/services/integrations/model-adapter-hydration.ts`），不要在业务 service 里另起炉灶。
4. 修数据形状相关的 bug 时，在测试里放各历史形状的夹具并断言收敛到当前形态，防止后人无意删断迁移链。
5. 会话 team 快照只是身份记录，执行期 Agent 配置（含 llm_tiers 引用）每次运行实时解析。llm_tiers 的 default 档引用解析不到时（悬空 provider、模型下架、半空残壳）回落系统 LLM，并在 readiness.llm.fallback_reason 标注失效供前端提示——失效兜底而非硬失败；系统 LLM 也解析不到、或 team/agent 本身已删除，才明确报缺失（快照副本不做回退）。场景 tier（如 fast）引用失效一律回落 default 档。系统内置 Agent 不写死示例 LLM tier，无 tier 时继承系统 LLM。

## 完成标准

后端改动在对应包内运行 `npm run typecheck` 与 `npm test`（backend-core、backend-local、受影响插件）；跨包契约改动需覆盖 backend-saas 的 typecheck。提交前至少运行根目录的 `npm run check:backend`。
