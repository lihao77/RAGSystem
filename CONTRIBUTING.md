# Contributing

感谢你对 RAGSystem 的关注。

## 开发环境 / Development setup

1. 准备 Node.js 24+ 和 npm。
2. 在仓库根目录执行 `npm ci`，并按 [README.md](README.md) 配置 `backend-ts/.env` 与 `frontend-client/.env`。
3. 启动后端：`cd backend-ts && npm run dev`
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

## Pull Request 建议 / Pull request guidance

- 说明变更动机与影响范围。
- 描述你执行过的验证步骤。
- 如果涉及 UI 或交互变更，请附截图或录屏。
