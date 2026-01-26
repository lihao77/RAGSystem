# -*- coding: utf-8 -*-
"""
MasterAgent V2 - 增强的主协调智能体

核心改进：
1. DAG 执行引擎 - 支持并行执行
2. 增强的上下文管理
3. 失败处理与重试
4. 执行计划可视化
5. 流式状态更新
"""

from .master_agent_v2 import MasterAgentV2

__all__ = ['MasterAgentV2']
