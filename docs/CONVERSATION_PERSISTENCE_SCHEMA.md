# 对话持久化数据库表结构

## 数据库
- SQLite 文件：`backend/data/ragsystem.db`（与向量库共用）
- 启用 WAL 模式与外键约束

## 表结构

### sessions
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| session_id | TEXT PK | 会话唯一标识 |
| user_id | TEXT | 用户 ID |
| metadata | TEXT | JSON 元数据 |
| created_at | TIMESTAMP | 创建时间 |
| updated_at | TIMESTAMP | 最后更新时间 |

索引：
- idx_sessions_updated_at(updated_at)
- idx_sessions_user_id(user_id)

### messages
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| seq | INTEGER PK AUTOINCREMENT | 自增序号 |
| id | TEXT UNIQUE | 消息唯一标识 |
| session_id | TEXT FK | 会话 ID |
| role | TEXT | user / assistant |
| content | TEXT | 消息内容 |
| metadata | TEXT | JSON 元数据 |
| created_at | TIMESTAMP | 创建时间 |

索引：
- idx_messages_session_seq(session_id, seq)
- idx_messages_session_created(session_id, created_at)

### sessions_archive
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| session_id | TEXT PK | 会话唯一标识 |
| user_id | TEXT | 用户 ID |
| metadata | TEXT | JSON 元数据 |
| created_at | TIMESTAMP | 创建时间 |
| updated_at | TIMESTAMP | 最后更新时间 |
| archived_at | TIMESTAMP | 归档时间 |

### messages_archive
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| seq | INTEGER | 原 seq |
| id | TEXT | 消息唯一标识 |
| session_id | TEXT | 会话 ID |
| role | TEXT | user / assistant |
| content | TEXT | 消息内容 |
| metadata | TEXT | JSON 元数据 |
| created_at | TIMESTAMP | 创建时间 |
| archived_at | TIMESTAMP | 归档时间 |
