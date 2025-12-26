# -*- coding: utf-8 -*-
"""
配置Schema生成器 - 从Pydantic模型生成增强的JSON Schema
用于前端动态表单生成
"""

from typing import Any, Dict, List, Optional, Type
from pydantic import BaseModel, Field
from pydantic.fields import FieldInfo
import inspect


class SchemaGenerator:
    """从Pydantic配置类生成增强的JSON Schema"""
    
    # 字段分组映射（可通过Field的json_schema_extra自定义）
    DEFAULT_GROUPS = {
        'api': {'label': 'API配置', 'order': 1},
        'database': {'label': '数据库配置', 'order': 1},
        'model': {'label': '模型配置', 'order': 2},
        'template': {'label': '模板配置', 'order': 3},
        'processing': {'label': '处理配置', 'order': 4},
        'metadata': {'label': '元数据配置', 'order': 5},
        'output': {'label': '输出设置', 'order': 6},
        'advanced': {'label': '高级配置', 'order': 7},
        'default': {'label': '基础配置', 'order': 0}
    }
    
    @classmethod
    def generate(cls, config_class: Type[BaseModel]) -> Dict[str, Any]:
        """
        生成增强的JSON Schema
        
        Args:
            config_class: Pydantic配置类
            
        Returns:
            增强的JSON Schema，包含UI渲染所需的额外信息
        """
        # 获取基础schema
        base_schema = config_class.model_json_schema()
        
        # 增强schema
        enhanced_schema = {
            'type': 'object',
            'title': base_schema.get('title', config_class.__name__),
            'description': base_schema.get('description', ''),
            'properties': {},
            'required': base_schema.get('required', [])
        }
        
        # 处理每个字段
        for field_name, field_info in config_class.model_fields.items():
            field_schema = cls._generate_field_schema(
                field_name, 
                field_info,
                base_schema.get('properties', {}).get(field_name, {})
            )
            enhanced_schema['properties'][field_name] = field_schema
        
        # 确保返回的schema完全可JSON序列化
        return cls._ensure_json_serializable(enhanced_schema)
    
    @classmethod
    def _ensure_json_serializable(cls, obj: Any) -> Any:
        """确保对象可JSON序列化"""
        import json
        from pydantic_core import PydanticUndefined
        
        if obj is None or obj is PydanticUndefined:
            return None
        elif isinstance(obj, (str, int, float, bool)):
            return obj
        elif isinstance(obj, dict):
            return {k: cls._ensure_json_serializable(v) for k, v in obj.items()}
        elif isinstance(obj, (list, tuple)):
            return [cls._ensure_json_serializable(item) for item in obj]
        else:
            # 尝试转换为字符串
            try:
                json.dumps(obj)
                return obj
            except (TypeError, ValueError):
                return str(obj)
    
    @classmethod
    def _generate_field_schema(
        cls, 
        field_name: str, 
        field_info: FieldInfo,
        base_field_schema: Dict[str, Any]
    ) -> Dict[str, Any]:
        """生成单个字段的增强schema"""
        
        # 处理默认值（避免PydanticUndefinedType）
        from pydantic_core import PydanticUndefined
        
        # 获取默认值
        default_value = None
        if field_info.default is not PydanticUndefined and field_info.default is not None:
            default_value = field_info.default
        elif field_info.default_factory is not None:
            # 如果有default_factory，调用它获取默认值
            try:
                default_value = field_info.default_factory()
            except Exception:
                # 如果调用失败，从base_schema获取
                default_value = base_field_schema.get('default', None)
        else:
            default_value = base_field_schema.get('default', None)
        
        # 如果默认值是Pydantic模型或包含Pydantic模型的列表，转换为字典
        if default_value is not None:
            if isinstance(default_value, BaseModel):
                default_value = default_value.model_dump()
            elif isinstance(default_value, list):
                default_value = [
                    item.model_dump() if isinstance(item, BaseModel) else item
                    for item in default_value
                ]
        
        # 基础信息
        field_schema = {
            'type': cls._get_field_type(field_info, base_field_schema),
            'title': field_info.title or cls._format_field_name(field_name),
            'description': field_info.description or ''
        }
        
        # 只在有有效默认值时添加
        if default_value is not None:
            field_schema['default'] = default_value
        
        # 从Field的json_schema_extra获取UI配置
        extra = field_info.json_schema_extra or {}
        if isinstance(extra, dict):
            # 分组信息
            field_schema['group'] = extra.get('group', cls._infer_group(field_name))
            field_schema['groupLabel'] = cls.DEFAULT_GROUPS.get(
                field_schema['group'], 
                {'label': field_schema['group']}
            )['label']
            field_schema['groupOrder'] = cls.DEFAULT_GROUPS.get(
                field_schema['group'], 
                {'order': 999}
            )['order']
            
            # 字段顺序
            field_schema['order'] = extra.get('order', 999)
            
            # UI控件类型
            field_schema['format'] = extra.get('format', cls._infer_format(field_name, field_schema['type']))
            
            # 选项列表
            if 'options' in extra:
                field_schema['options'] = extra['options']
            
            # 占位符
            field_schema['placeholder'] = extra.get('placeholder', field_info.description)
            
            # 文本框行数
            if field_schema['format'] == 'textarea':
                field_schema['rows'] = extra.get('rows', 3)
            
            # 数字范围
            if field_schema['type'] in ['number', 'integer']:
                if 'minimum' in extra:
                    field_schema['minimum'] = extra['minimum']
                if 'maximum' in extra:
                    field_schema['maximum'] = extra['maximum']
                if 'multipleOf' in extra:
                    field_schema['multipleOf'] = extra['multipleOf']
            
            # 字符串长度
            if field_schema['type'] == 'string':
                if 'minLength' in extra:
                    field_schema['minLength'] = extra['minLength']
                if 'maxLength' in extra:
                    field_schema['maxLength'] = extra['maxLength']
                if 'pattern' in extra:
                    field_schema['pattern'] = extra['pattern']
                    field_schema['patternMessage'] = extra.get('patternMessage', '格式不正确')
        
        # 从base_field_schema获取枚举值
        if 'enum' in base_field_schema:
            field_schema['enum'] = base_field_schema['enum']
        
        return field_schema
    
    @classmethod
    def _get_field_type(cls, field_info: FieldInfo, base_schema: Dict[str, Any]) -> str:
        """获取字段类型"""
        if 'type' in base_schema:
            return base_schema['type']
        
        # 从annotation推断
        annotation = field_info.annotation
        if annotation == str:
            return 'string'
        elif annotation == int:
            return 'integer'
        elif annotation == float:
            return 'number'
        elif annotation == bool:
            return 'boolean'
        elif hasattr(annotation, '__origin__'):
            if annotation.__origin__ == list:
                return 'array'
            elif annotation.__origin__ == dict:
                return 'object'
        
        return 'string'
    
    @classmethod
    def _infer_group(cls, field_name: str) -> str:
        """根据字段名推断分组"""
        field_lower = field_name.lower()
        
        if any(k in field_lower for k in ['api', 'key']):
            return 'api'
        elif any(k in field_lower for k in ['neo4j', 'database', 'db', 'uri', 'connection']):
            return 'database'
        elif any(k in field_lower for k in ['model', 'temperature', 'token']):
            return 'model'
        elif any(k in field_lower for k in ['template', 'prompt']):
            return 'template'
        elif any(k in field_lower for k in ['chunk', 'process', 'parse', 'extract', 'worker', 'parallel']):
            return 'processing'
        elif any(k in field_lower for k in ['document', 'source', 'language', 'type']):
            return 'metadata'
        elif any(k in field_lower for k in ['output', 'save', 'export']):
            return 'output'
        elif any(k in field_lower for k in ['timeout', 'retry', 'encoding', 'debug', 'clear', 'overwrite']):
            return 'advanced'
        
        return 'default'
    
    @classmethod
    def _infer_format(cls, field_name: str, field_type: str) -> str:
        """根据字段名和类型推断UI格式"""
        field_lower = field_name.lower()
        
        if field_type == 'string':
            if any(k in field_lower for k in ['text', 'content', 'prompt', 'description']):
                return 'textarea'
            elif any(k in field_lower for k in ['password', 'secret', 'key']):
                return 'password'
        elif field_type == 'object':
            return 'json'
        
        return field_type
    
    @classmethod
    def _format_field_name(cls, field_name: str) -> str:
        """格式化字段名为可读标题"""
        # 将下划线转换为空格，首字母大写
        return ' '.join(word.capitalize() for word in field_name.split('_'))


def add_ui_metadata(field_kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """
    辅助函数：为Field添加UI元数据
    
    使用示例:
        api_key: str = Field(
            default="",
            description="OpenAI API密钥",
            **add_ui_metadata({
                'group': 'api',
                'order': 1,
                'format': 'password'
            })
        )
    """
    if 'json_schema_extra' not in field_kwargs:
        field_kwargs['json_schema_extra'] = {}
    
    field_kwargs['json_schema_extra'].update(field_kwargs.pop('ui_metadata', {}))
    
    return field_kwargs
