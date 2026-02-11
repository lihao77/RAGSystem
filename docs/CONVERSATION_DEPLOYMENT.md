# 对话持久化部署与配置指南

## 数据库位置
默认使用 `backend/data/ragsystem.db`，与向量存储共用。

如需调整路径，可在配置中修改：
`vector_store.sqlite_vec.database_path`

## 启动方式
持久化在服务启动后自动可用，无需额外脚本。

## 备份与恢复
备份脚本：
```bash
cd backend
python utils/backup_database.py
```

恢复脚本：
```bash
cd backend
python utils/backup_database.py --restore <备份文件>
```

## 过期清理策略
- 默认保留 30 天
- 过期会话自动归档并删除

如需调整策略，可在初始化 ConversationStore 时传入：
- `session_ttl_days`
- `cleanup_interval_seconds`

## 灾备建议
- 定期执行备份（每日/每周）
- 将备份文件同步到异地存储
