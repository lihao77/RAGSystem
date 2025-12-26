# LLMJson v2 节点 - 使用内置模板

基于 llmjson v2 的信息提取节点，使用内置专业模板，用户只需配置基本参数。

## 🚀 快速开始

### 最简单的使用方式

```python
from nodes.llmjson_v2 import LLMJsonV2Node, LLMJsonV2NodeConfig

# 只需要一个API密钥
config = LLMJsonV2NodeConfig(api_key="your-api-key")

node = LLMJsonV2Node()
node.configure(config)

result = node.execute({"text": "张三在阿里巴巴工作"})
```

## 📋 配置参数

### 必需参数
- `api_key`: OpenAI API密钥

### 常用参数
- `template`: 模板选择 (默认: "universal")
  - `universal`: 通用信息提取
  - `flood`: 洪涝灾害信息提取
- `model`: 模型名称 (默认: "gpt-4o-mini")
- `temperature`: 生成温度 (默认: 0.1)

### 高级参数
- `base_url`: API基础URL
- `max_tokens`: 最大输出长度
- `chunk_size`: 文档分块大小
- `include_tables`: 处理表格内容

## 🎯 内置模板

### Universal 模板
- **文件**: `llmjson/templates/universal.yaml`
- **用途**: 通用实体关系提取
- **输出**: entities, relations
- **适用**: 一般文本、新闻、商业文档等

### Flood 模板  
- **文件**: `llmjson/templates/flood_disaster.yaml`
- **用途**: 专业洪涝灾害信息提取
- **输出**: 基础实体, 状态实体, 状态关系
- **特点**: 
  - 严格的ID格式 (如: E-420000-20230615-HEAVY_RAIN)
  - 专业的时间格式 (YYYY-MM-DD至YYYY-MM-DD)
  - 洪涝灾害专用实体类型和关系

## 📝 使用示例

### 通用信息提取
```python
config = LLMJsonV2NodeConfig(
    api_key="your-key",
    template="universal"
)
```

### 洪涝灾害信息提取
```python
config = LLMJsonV2NodeConfig(
    api_key="your-key", 
    template="flood"
)
```

### 完整配置
```python
config = LLMJsonV2NodeConfig(
    api_key="your-key",
    template="flood",
    model="gpt-4o-mini",
    temperature=0.05,
    chunk_size=1500
)
```

## 🔧 工作流配置

### 基础工作流
```json
{
  "nodes": [{
    "type": "llmjson_v2",
    "config": {
      "api_key": "${OPENAI_API_KEY}",
      "template": "universal"
    }
  }]
}
```

### 洪涝灾害工作流
```json
{
  "nodes": [{
    "type": "llmjson_v2",
    "config": {
      "api_key": "${OPENAI_API_KEY}",
      "template": "flood"
    }
  }]
}
```

## 📊 输出格式

### Universal 模板输出
```json
{
  "entities": [
    {
      "type": "person",
      "name": "张三", 
      "id": "P-张三-001"
    }
  ],
  "relations": [
    {
      "source": "P-张三-001",
      "relation": "工作于",
      "target": "O-苹果公司-001"
    }
  ]
}
```

### Flood 模板输出
```json
{
  "基础实体": [
    {
      "类型": "事件",
      "名称": "持续性强降雨过程",
      "唯一ID": "E-420000-20230615-HEAVY_RAIN"
    }
  ],
  "状态实体": [
    {
      "类型": "独立状态",
      "状态ID": "E-420000-20230615-HEAVY_RAIN-20230615_20230616",
      "时间": "2023-06-15至2023-06-16"
    }
  ],
  "状态关系": [
    {
      "主体状态ID": "...",
      "关系": "导致", 
      "客体状态ID": "..."
    }
  ]
}
```

## 🎯 实现原理

### 模板使用方式
1. **内置模板**: 直接使用 llmjson 的专业 YAML 模板文件
2. **用户配置**: 根据节点配置生成处理器参数
3. **动态组合**: 模板 + 用户配置 = 完整的处理器配置

### 配置生成流程
```python
# 1. 获取内置模板路径
template_path = "llmjson/templates/universal.yaml"

# 2. 生成处理器配置
processor_config = {
    "template": {"config_path": template_path},
    "processor": {
        "api_key": user_config.api_key,
        "model": user_config.model,
        "temperature": user_config.temperature
        # ... 其他用户配置
    }
}

# 3. 创建处理器
processor = ProcessorFactory.create_from_config(processor_config)
```

## 🆚 与其他版本对比

| 特性 | v1 | v2 (自定义) | v2 (内置模板) |
|------|----|-----------| -------------|
| 配置复杂度 | 中等 | 高 | 极简 |
| 模板来源 | 硬编码 | 用户自定义 | 内置专业模板 |
| 专业程度 | 基础 | 取决于用户 | 专业优化 |
| 学习成本 | 中等 | 高 | 极低 |
| 适用场景 | 洪涝灾害 | 任意领域 | 通用+洪涝灾害 |

## 🔍 故障排除

### 常见问题
1. **模板文件不存在**: 检查 llmjson 目录是否正确
2. **API密钥错误**: 检查密钥是否正确设置
3. **输出格式异常**: 不同模板有不同的输出格式

### 调试技巧
- 检查返回的 `stats` 了解处理状态
- 使用测试脚本验证节点配置
- 查看 llmjson 日志了解详细错误

## ✨ 优势

1. **开箱即用**: 使用专业优化的内置模板
2. **配置简单**: 只需要几个基本参数
3. **专业质量**: 模板经过专业设计和优化
4. **灵活选择**: 支持通用和专业领域模板
5. **易于维护**: 模板更新自动生效