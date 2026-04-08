# Contributing

感谢你对 RAGSystem 的关注。

## 开发环境 / Development setup

1. 准备 Python 3.12、Node.js 20+ 和 npm。
2. 按 [README.md](README.md) 中的步骤复制 `.env` 文件，并使用运行时配置目录（默认 `~/.ragsystem/config`，或 `<RAG_DATA_ROOT>/config`）。
3. 启动后端：`cd backend-fastapi && python main.py`
4. 启动前端：`cd frontend-client && npm install && npm run dev`

## 提交前检查 / Before opening a PR

请至少运行以下命令：

```bash
cd backend-fastapi
python -m compileall .
python -m py_compile main.py
pytest --basetemp=.pytest-tmp agents/tests/
cd ../frontend-client && npm run build
```

## 文档同步 / Documentation updates

- 修改系统行为时，请同步更新对应架构文档。
- 根 README 保持总览，详细设计请写入 `docs/` 或子目录文档。
- 不要提交真实密钥、令牌、内网地址或本地临时产物。

## Pull Request 建议 / Pull request guidance

- 说明变更动机与影响范围。
- 描述你执行过的验证步骤。
- 如果涉及 UI 或交互变更，请附截图或录屏。
