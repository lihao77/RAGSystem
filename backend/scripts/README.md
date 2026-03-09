# 维护脚本

`backend/scripts/` 当前只保留少量维护脚本。

## runtime_strict_audit.py

用途：

- 扫描 `get_runtime_dependency(...)` 的使用点
- 统计 fallback 类型
- 校验是否全部收敛到 `container_only`

常用命令：

```powershell
python backend\scripts\runtime_strict_audit.py --format table
python backend\scripts\runtime_strict_audit.py --format json
python backend\scripts\runtime_strict_audit.py --check-container-only
```

## 约定

- 脚本默认从仓库根或 `backend/` 运行
- 需要重复执行时应保持幂等
- 运行结果以命令输出为准，不依赖文档中的旧交付说明
