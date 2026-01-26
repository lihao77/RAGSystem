# 智能体动态启用/禁用问题修复

## 问题描述

用户在前端禁用了某个智能体（`enabled: false`）后，MasterAgent 仍然会将任务分配给该智能体。

### 复现步骤

1. 在前端智能体配置页面，关闭某个智能体的启用状态
2. 提交一个应该由其他智能体处理的任务
3. MasterAgent 仍然会选择被禁用的智能体

## 根本原因

系统的智能体加载和注册机制存在以下问题：

1. **初始加载时**（`routes/agent.py:30-64`）：
   - `load_agents_from_config()` 会正确过滤 `enabled=false` 的智能体
   - 只有启用的智能体会被注册到 orchestrator

2. **配置更新时**（`routes/agent_config.py:87-140, 143-221`）：
   - 配置文件被正确更新（`enabled: false`）
   - **但 orchestrator 中的智能体注册表没有更新**
   - MasterAgent 调用 `orchestrator.list_agents()` 仍然看到旧的智能体列表

3. **MasterAgent 任务分析**（`agents/master_agent.py:620-627`）：
   - 使用 `orchestrator.list_agents()` 获取可用智能体
   - 该方法返回**所有已注册的智能体**，不考虑 `enabled` 状态
   - LLM 看到所有智能体（包括禁用的），可能分配任务给禁用的智能体

## 修复方案

### 核心思路

**在配置更新后，自动重新加载 orchestrator 中的智能体注册**。

### 实现步骤

#### 1. 在 `routes/agent.py` 中添加重新加载函数

```python
def reload_agents():
    """
    重新加载 orchestrator 中的智能体（用于配置更新后刷新）

    这个函数会：
    1. 清除旧的智能体注册
    2. 重新加载所有启用的智能体
    3. 注册到 orchestrator

    Returns:
        bool: 是否重新加载成功
    """
    global _orchestrator

    if _orchestrator is None:
        logger.warning("orchestrator 未初始化，跳过重新加载")
        return False

    try:
        # 清空现有智能体（保留注册表对象）
        _orchestrator.registry.clear()
        logger.info("已清空 orchestrator 中的智能体注册")

        # 重新加载智能体
        system_config = get_config()
        adapter = get_default_adapter()

        agents = load_agents_from_config(
            llm_adapter=adapter,
            system_config=system_config,
            orchestrator=_orchestrator
        )

        # 重新注册
        for agent_name, agent in agents.items():
            _orchestrator.register_agent(agent)
            logger.info(f"已重新注册智能体: {agent_name}")

        logger.info(f"智能体重新加载完成，共加载 {len(agents)} 个智能体")
        return True

    except Exception as e:
        logger.error(f"重新加载智能体失败: {e}", exc_info=True)
        return False
```

#### 2. 在 `routes/agent_config.py` 中调用重新加载

在以下两个配置更新端点中添加 `_reload_agents()` 调用：

- **PUT `/api/agent-config/configs/<agent_name>`**（完整更新）
- **PATCH `/api/agent-config/configs/<agent_name>`**（部分更新）

```python
def _reload_agents():
    """重新加载 orchestrator 中的智能体"""
    try:
        from routes.agent import reload_agents

        success = reload_agents()
        if success:
            logger.info("智能体重新加载成功")
        else:
            logger.warning("智能体重新加载失败，但不影响配置保存")

    except Exception as e:
        logger.error(f"重新加载智能体异常: {e}", exc_info=True)
        # 不抛出异常，避免影响配置更新

# 在 update_config 和 patch_config 中添加调用
@agent_config_bp.route('/configs/<agent_name>', methods=['PUT'])
def update_config(agent_name):
    ...
    config_manager.set_config(config, save=True)

    # 🔧 重新加载 orchestrator 中的智能体（反映 enabled 状态变化）
    _reload_agents()

    return success_response(...)
```

## 修复效果

修复后的系统行为：

1. **初始启动**：
   - 只加载 `enabled=true` 的智能体
   - 注册到 orchestrator

2. **配置更新**：
   - 更新配置文件（`enabled: false/true`）
   - **自动触发重新加载**
   - orchestrator 清除旧的注册，重新加载启用的智能体

3. **任务分配**：
   - MasterAgent 调用 `orchestrator.list_agents()`
   - **只返回当前启用的智能体**
   - LLM 只能看到启用的智能体，不会分配给禁用的智能体

## 测试验证

运行测试脚本验证修复：

```bash
cd backend
python test_agent_reload.py
```

**预期输出**：
```
步骤 1: 初始化系统
步骤 2: 初始加载智能体
✅ 初始加载完成，共 N 个智能体

步骤 3: 禁用智能体 'test_agent'
✅ 已将 'test_agent' 设置为 disabled

步骤 4: 重新加载智能体
✅ 重新加载完成，共 N-1 个智能体
✅ 测试通过！禁用的智能体 'test_agent' 已不在列表中

步骤 6: 重新启用智能体 'test_agent'
✅ 重新加载完成，共 N 个智能体
✅ 测试通过！重新启用的智能体 'test_agent' 已回到列表中

🎉 所有测试通过！智能体重新加载机制工作正常
```

## 技术细节

### 为什么使用 `registry.clear()` 而不是重新创建 orchestrator？

- `registry.clear()` 保留注册表对象，只清空智能体映射
- 避免影响其他持有 orchestrator 引用的模块
- 更轻量级，不需要重新初始化整个 orchestrator

### 为什么在 `agent_config.py` 中使用延迟导入？

```python
from routes.agent import reload_agents  # 在函数内部导入
```

- 避免循环依赖（`agent.py` 导入 `agent_config_bp`）
- 只在需要时导入，不影响模块加载

### 错误处理策略

- 重新加载失败**不影响配置保存**
- 只记录警告日志，不抛出异常
- 用户配置仍然被保存，下次服务重启会生效

## 后续优化建议

1. **缓存机制**：
   - 如果智能体数量很多，每次配置更新都重新加载可能较慢
   - 可以考虑只重新加载变更的智能体

2. **前端反馈**：
   - 配置更新成功后，前端显示"智能体已重新加载"提示
   - 如果重新加载失败，提示用户重启后端服务

3. **测试覆盖**：
   - 添加自动化测试，覆盖智能体启用/禁用场景
   - 验证 MasterAgent 的任务分配逻辑

## 相关文件

**修改的文件**：
- `backend/routes/agent.py` - 添加 `reload_agents()` 函数
- `backend/routes/agent_config.py` - 在配置更新后调用重新加载

**测试文件**：
- `backend/test_agent_reload.py` - 智能体重新加载测试

**文档文件**：
- `backend/AGENT_RELOAD_FIX.md` - 本文档
