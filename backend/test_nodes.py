#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
节点系统测试脚本 - 最小可执行验证
"""

import sys
from pathlib import Path

# 添加 backend 到路径
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))


def test_registry():
    """测试节点注册"""
    print("\n" + "="*50)
    print("测试 1: 节点注册中心")
    print("="*50)
    
    from nodes import init_registry
    
    registry = init_registry()
    
    print(f"\n已注册的节点类型: {registry.list_types()}")
    
    for definition in registry.list_all():
        print(f"\n节点: {definition.name}")
        print(f"  类型: {definition.type}")
        print(f"  分类: {definition.category}")
        print(f"  描述: {definition.description}")
        print(f"  输入: {[i['name'] for i in definition.inputs]}")
        print(f"  输出: {[o['name'] for o in definition.outputs]}")


def test_node_config():
    """测试节点配置"""
    print("\n" + "="*50)
    print("测试 2: 节点配置")
    print("="*50)
    
    from nodes import get_registry
    
    registry = get_registry()
    
    # 测试 LLMJson 节点
    llmjson_class = registry.get("llmjson")
    default_config = llmjson_class.get_default_config()
    
    print(f"\nLLMJson 默认配置:")
    print(f"  model: {default_config.model}")
    print(f"  temperature: {default_config.temperature}")
    print(f"  chunk_size: {default_config.chunk_size}")
    
    # 测试 Json2Graph 节点
    j2g_class = registry.get("json2graph")
    j2g_config = j2g_class.get_default_config()
    
    print(f"\nJson2Graph 默认配置:")
    print(f"  store_mode: {j2g_config.store_mode}")
    print(f"  处理器数量: {len(j2g_config.processors)}")
    for p in j2g_config.processors:
        print(f"    - {p.name}: {p.class_path}")


def test_config_store():
    """测试配置存储"""
    print("\n" + "="*50)
    print("测试 3: 配置存储")
    print("="*50)
    
    from nodes import NodeConfigStore, get_registry
    from nodes.llmjson.config import LLMJsonNodeConfig
    
    store = NodeConfigStore()
    registry = get_registry()
    
    # 创建一个测试配置
    test_config = LLMJsonNodeConfig(
        api_key="test-key-123",
        base_url="https://api.deepseek.com/v1",
        model="deepseek-chat",
        temperature=0.2
    )
    
    # 保存配置
    config_id = store.save_config(
        node_type="llmjson",
        config=test_config,
        name="test_deepseek",
        description="测试DeepSeek配置",
        tags=["test", "deepseek"]
    )
    
    print(f"\n保存配置成功，ID: {config_id}")
    
    # 列出配置
    configs = store.list_configs(node_type="llmjson")
    print(f"\n已保存的 llmjson 配置:")
    for c in configs:
        print(f"  - {c.name} ({c.id}): {c.description}")
    
    # 加载配置
    llmjson_class = registry.get("llmjson")
    loaded_config = store.load_config(config_id, llmjson_class)
    
    print(f"\n加载的配置:")
    print(f"  model: {loaded_config.model}")
    print(f"  base_url: {loaded_config.base_url}")
    
    # 清理测试配置
    store.delete_config(config_id)
    print(f"\n已删除测试配置")


def test_node_instance():
    """测试节点实例化"""
    print("\n" + "="*50)
    print("测试 4: 节点实例化")
    print("="*50)
    
    from nodes import get_registry
    
    registry = get_registry()
    
    # 创建 LLMJson 节点实例
    llmjson_node = registry.create_instance("llmjson")
    
    # 配置节点
    llmjson_node.configure_from_dict({
        "api_key": "test-key",
        "model": "gpt-4o-mini"
    })
    
    # 验证配置
    errors = llmjson_node.validate()
    print(f"\nLLMJson 节点验证: {'通过' if not errors else errors}")
    
    # 创建 Json2Graph 节点实例
    j2g_node = registry.create_instance("json2graph")
    j2g_node.configure_from_dict({
        "neo4j_password": "test-password"
    })
    
    # 测试处理器管理
    print(f"\n默认处理器:")
    for p in j2g_node.list_processors():
        print(f"  - {p['name']}")
    
    # 添加自定义处理器
    j2g_node.add_processor(
        name="CustomProcessor",
        class_path="my.custom.Processor",
        params={"key": "value"}
    )
    
    print(f"\n添加处理器后:")
    for p in j2g_node.list_processors():
        print(f"  - {p['name']}")
    
    # 移除处理器
    j2g_node.remove_processor("CustomProcessor")
    print(f"\n移除处理器后: {len(j2g_node.list_processors())} 个")


def test_node_execute_mock():
    """测试节点执行（模拟）"""
    print("\n" + "="*50)
    print("测试 5: 节点执行（模拟，不实际调用API）")
    print("="*50)
    
    from nodes import get_registry
    
    registry = get_registry()
    
    # 创建节点
    llmjson_node = registry.create_instance("llmjson")
    llmjson_node.configure_from_dict({
        "api_key": "",  # 空key，会触发导入检查
        "model": "gpt-4o-mini"
    })
    
    # 尝试执行（会返回错误信息，因为没有真实的API key）
    print("\n执行 LLMJson 节点 (无API key):")
    result = llmjson_node.execute({"text": "测试文本"})
    print(f"  结果: {result.get('stats', {})}")


def main():
    """运行所有测试"""
    print("\n" + "#"*60)
    print("#  节点系统最小可执行测试")
    print("#"*60)
    
    test_registry()
    test_node_config()
    test_config_store()
    test_node_instance()
    test_node_execute_mock()
    
    print("\n" + "="*50)
    print("✅ 所有测试完成!")
    print("="*50)


if __name__ == "__main__":
    main()
