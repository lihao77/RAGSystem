#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLMJson v2 节点使用示例 - 使用内置模板
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

def example_minimal_usage():
    """最简使用示例"""
    print("=" * 60)
    print("LLMJson v2 最简使用示例")
    print("=" * 60)
    
    try:
        from nodes.llmjson_v2 import LLMJsonV2Node, LLMJsonV2NodeConfig
        
        # 极简配置 - 只需要API密钥
        config = LLMJsonV2NodeConfig(api_key="your-api-key-here")
        
        node = LLMJsonV2Node()
        node.configure(config)
        
        sample_text = "张三在阿里巴巴公司工作，负责开发淘宝产品。"
        
        print("✅ 配置成功！")
        print(f"输入文本: {sample_text}")
        print(f"使用模板: {config.template} (通用)")
        print("使用llmjson内置的universal模板")
        
        return True
        
    except Exception as e:
        print(f"❌ 示例失败: {e}")
        return False

def example_template_selection():
    """模板选择示例"""
    print("\n" + "=" * 60)
    print("内置模板选择示例")
    print("=" * 60)
    
    templates = {
        "universal": "通用信息提取 (使用llmjson内置universal模板)",
        "flood": "洪涝灾害信息提取 (使用llmjson内置flood模板)"
    }
    
    print("可用内置模板:")
    for template, desc in templates.items():
        print(f"- {template}: {desc}")
    
    try:
        from nodes.llmjson_v2 import LLMJsonV2NodeConfig
        
        # 选择洪涝灾害模板
        config = LLMJsonV2NodeConfig(
            api_key="your-api-key",
            template="flood"  # 使用内置洪涝灾害模板
        )
        
        print(f"\n✅ 洪涝灾害模板配置成功!")
        print("将使用llmjson内置的flood_disaster.yaml模板")
        print("包含专业的洪涝灾害实体和关系定义")
        
        return True
        
    except Exception as e:
        print(f"❌ 模板示例失败: {e}")
        return False

def example_complete_config():
    """完整配置示例"""
    print("\n" + "=" * 60)
    print("完整配置示例")
    print("=" * 60)
    
    try:
        from nodes.llmjson_v2 import LLMJsonV2NodeConfig
        
        # 完整配置
        config = LLMJsonV2NodeConfig(
            api_key="your-api-key",
            template="universal",  # 使用内置通用模板
            model="gpt-4o-mini",
            temperature=0.05,      # 更保守
            chunk_size=1500,       # 较小分块
            include_tables=True
        )
        
        print("✅ 完整配置成功!")
        print(f"模板: {config.template} (内置)")
        print(f"模型: {config.model}")
        print(f"温度: {config.temperature}")
        print(f"分块大小: {config.chunk_size}")
        print("直接使用llmjson的内置配置和模板")
        
        return True
        
    except Exception as e:
        print(f"❌ 完整配置示例失败: {e}")
        return False

def example_workflow_config():
    """工作流配置示例"""
    print("\n" + "=" * 60)
    print("工作流配置示例")
    print("=" * 60)
    
    print("极简工作流配置:")
    print("""
{
  "nodes": [{
    "type": "llmjson_v2",
    "config": {
      "api_key": "${OPENAI_API_KEY}",
      "template": "universal"
    }
  }]
}
""")
    
    print("洪涝灾害工作流:")
    print("""
{
  "nodes": [{
    "type": "llmjson_v2",
    "config": {
      "api_key": "${OPENAI_API_KEY}",
      "template": "flood"
    }
  }]
}
""")
    
    print("优势:")
    print("- 直接使用llmjson的专业模板")
    print("- 无需自定义复杂配置")
    print("- 模板经过专业优化")
    
    return True

def example_flood_disaster():
    """洪涝灾害专用示例"""
    print("\n" + "=" * 60)
    print("洪涝灾害信息提取示例")
    print("=" * 60)
    
    try:
        from nodes.llmjson_v2 import LLMJsonV2NodeConfig
        
        # 洪涝灾害专用配置
        config = LLMJsonV2NodeConfig(
            api_key="your-api-key",
            template="flood"  # 使用内置洪涝灾害模板
        )
        
        # 洪涝灾害示例文本
        disaster_text = """
        2024年7月15日，长江中下游地区遭遇强降雨，武汉市24小时降雨量达到150毫米。
        汉江水位上涨至警戒线以上，武汉市防汛指挥部启动二级应急响应。
        消防救援队伍紧急出动，疏散了江岸区500名居民到安全地带。
        """
        
        print("洪涝灾害文本:", disaster_text.strip())
        print(f"\n✅ 使用内置flood模板!")
        print("模板特点:")
        print("- 专业的洪涝灾害实体定义")
        print("- 基础实体、状态实体、状态关系")
        print("- 严格的ID格式和时间格式")
        print("- 专业的提示词优化")
        
        return True
        
    except Exception as e:
        print(f"❌ 洪涝灾害示例失败: {e}")
        return False

if __name__ == "__main__":
    print("LLMJson v2 内置模板使用指南")
    print("=" * 60)
    
    success1 = example_minimal_usage()
    success2 = example_template_selection() 
    success3 = example_complete_config()
    success4 = example_workflow_config()
    success5 = example_flood_disaster()
    
    if all([success1, success2, success3, success4, success5]):
        print("\n🎉 所有示例运行成功!")
        print("\n📝 使用总结:")
        print("1. 极简配置：只需要 api_key")
        print("2. 内置模板：universal 和 flood")
        print("3. 专业优化：使用llmjson的专业模板")
        print("4. 开箱即用：无需复杂配置")
        
        print("\n🚀 快速开始:")
        print("config = LLMJsonV2NodeConfig(api_key='your-key')")
        print("# 或者")
        print("config = LLMJsonV2NodeConfig(api_key='your-key', template='flood')")
        
        print("\n📋 内置模板说明:")
        print("- universal: 通用实体关系提取")
        print("- flood: 专业洪涝灾害信息提取")
    else:
        print("\n❌ 部分示例失败")
        sys.exit(1)