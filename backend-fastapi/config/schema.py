# -*- coding: utf-8 -*-
"""
配置 Schema 生成 - 从 Pydantic 模型自动生成前端 config_fields 格式。

输出格式与 ModelProviderManager 的 config_fields 约定一致，
前端 SchemaForm 组件可直接消费。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Type

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# 中文 label 映射（group key → 显示名）
# ---------------------------------------------------------------------------

_APPCONFIG_LABEL_OVERRIDES: Dict[str, str] = {
    'llm': 'LLM 配置',
    'system': '系统配置',
    'embedding': 'Embedding 配置',
    'vector_store': '向量存储',
    'vector_store.sqlite_vec': 'SQLite 向量存储',
    'vector_store.postgresql': 'PostgreSQL 向量存储',
    'hooks': 'Hook 系统',
    'hooks.workspace_trust': '工作区信任',
    'waiting': '后台等待与保活',
    'reflection': '反思机制',
    'memory': '记忆系统',
    'tools': '工具限制',
    'context': '上下文预算',
}

# 敏感字段名模式（自动识别为 password 类型）
_SENSITIVE_FIELD_NAMES = {'password', 'api_key', 'secret', 'token', 'secret_key'}


# ---------------------------------------------------------------------------
# 公开接口
# ---------------------------------------------------------------------------

def generate_config_schema(
    model_class: Type[BaseModel],
    label_overrides: Optional[Dict[str, str]] = None,
    exclude_fields: Optional[Set[str]] = None,
) -> Dict[str, Any]:
    """从 Pydantic 模型生成 grouped config_fields schema。

    Args:
        model_class: Pydantic BaseModel 子类
        label_overrides: group key / field key → 中文显示名
        exclude_fields: 排除的顶层字段名

    Returns:
        {"groups": [{"key", "label", "description", "fields": [...]}, ...]}
    """
    schema = model_class.model_json_schema()
    defs = schema.get('$defs', {})
    overrides = {**_APPCONFIG_LABEL_OVERRIDES, **(label_overrides or {})}
    exclude = exclude_fields or set()

    groups: List[Dict[str, Any]] = []

    for prop_name, prop_schema in schema.get('properties', {}).items():
        if prop_name in exclude or prop_name == 'model_config':
            continue

        resolved = _resolve_ref(prop_schema, defs)

        if _is_object_type(resolved):
            # 嵌套模型 → 生成 group（可能递归展开子嵌套）
            group = _build_group(prop_name, resolved, defs, overrides)
            if group['fields'] or group.get('_sub_groups'):
                # 展平子组到顶层
                sub_groups = group.pop('_sub_groups', [])
                for sg in sub_groups:
                    sg.pop('_sub_groups', None)
                if group['fields']:
                    groups.append(group)
                groups.extend(sub_groups)
        else:
            # 顶层标量 → 放入 _root 组
            field = _build_field(prop_name, resolved, overrides)
            if field:
                _ensure_root_group(groups, overrides)
                groups[0]['fields'].append(field)

    return {'groups': groups}


# ---------------------------------------------------------------------------
# 内部实现
# ---------------------------------------------------------------------------

def _resolve_ref(prop: Dict[str, Any], defs: Dict[str, Any]) -> Dict[str, Any]:
    """解析 $ref 和 allOf 引用。"""
    if '$ref' in prop:
        ref_name = prop['$ref'].rsplit('/', 1)[-1]
        return defs.get(ref_name, prop)

    if 'allOf' in prop:
        merged: Dict[str, Any] = {}
        for item in prop['allOf']:
            resolved = _resolve_ref(item, defs)
            merged.update(resolved)
        # 保留外层的 title/description/default
        for key in ('title', 'description', 'default'):
            if key in prop:
                merged[key] = prop[key]
        return merged

    if 'anyOf' in prop:
        # Optional[T] 在 Pydantic v2 中生成 anyOf: [{type: T}, {type: null}]
        for variant in prop['anyOf']:
            resolved = _resolve_ref(variant, defs)
            if resolved.get('type') != 'null':
                result = dict(resolved)
                for key in ('title', 'description', 'default'):
                    if key in prop:
                        result[key] = prop[key]
                return result
        return prop

    return prop


def _is_object_type(schema: Dict[str, Any]) -> bool:
    """判断 schema 是否描述一个嵌套对象。"""
    return schema.get('type') == 'object' and 'properties' in schema


def _is_simple_type(schema: Dict[str, Any]) -> bool:
    """判断 schema 是否为可渲染的简单类型（非 object/array/dict）。"""
    t = schema.get('type', '')
    if t in ('string', 'integer', 'number', 'boolean'):
        return True
    if 'enum' in schema:
        return True
    return False


def _build_group(
    group_key: str,
    schema: Dict[str, Any],
    defs: Dict[str, Any],
    overrides: Dict[str, str],
) -> Dict[str, Any]:
    """构建一个 group（对应一个嵌套模型）。"""
    fields: List[Dict[str, Any]] = []
    sub_groups: List[Dict[str, Any]] = []

    for prop_name, prop_schema in schema.get('properties', {}).items():
        if prop_name == 'model_config':
            continue

        resolved = _resolve_ref(prop_schema, defs)

        if _is_object_type(resolved):
            # 二级嵌套 → 递归生成子 group，使用 dotted key
            sub_key = f'{group_key}.{prop_name}'
            sub_group = _build_group(sub_key, resolved, defs, overrides)
            if sub_group['fields']:
                sub_groups.append(sub_group)
        elif _is_simple_type(resolved):
            field = _build_field(prop_name, resolved, overrides)
            if field:
                fields.append(field)
        # 跳过 array/dict 等复杂类型

    return {
        'key': group_key,
        'label': overrides.get(group_key, schema.get('title', group_key)),
        'description': schema.get('description', ''),
        'fields': fields,
        '_sub_groups': sub_groups,
    }


def _build_field(
    field_key: str,
    schema: Dict[str, Any],
    overrides: Dict[str, str],
) -> Optional[Dict[str, Any]]:
    """构建单个 field 描述。"""
    field_type = _map_field_type(field_key, schema)
    if not field_type:
        return None

    result: Dict[str, Any] = {
        'key': field_key,
        'label': overrides.get(field_key, schema.get('title', _key_to_label(field_key))),
        'type': field_type,
        'default': schema.get('default'),
        'help': schema.get('description', ''),
    }

    # 约束提取
    if field_type == 'number':
        for src, dst in [('minimum', 'min'), ('exclusiveMinimum', 'min'),
                         ('maximum', 'max'), ('exclusiveMaximum', 'max')]:
            if src in schema:
                result[dst] = schema[src]
        # step 推断
        if schema.get('type') == 'integer':
            result['step'] = 1
        else:
            result.setdefault('step', 0.1)

    if field_type == 'select':
        enum_values = schema.get('enum', [])
        result['options'] = [{'value': v, 'label': str(v)} for v in enum_values]
        # Optional 字段追加空选项（允许清除）
        if schema.get('default') is None:
            result['options'].insert(0, {'value': '', 'label': '未设置'})

    return result


def _map_field_type(field_key: str, schema: Dict[str, Any]) -> Optional[str]:
    """从 JSON Schema 类型映射到前端 field type。"""
    # 检查 json_schema_extra 中的 format
    fmt = schema.get('format', '')
    if fmt == 'password':
        return 'password'

    # 敏感字段名自动识别
    if field_key in _SENSITIVE_FIELD_NAMES:
        return 'password'

    # enum → select
    if 'enum' in schema:
        return 'select'

    t = schema.get('type', '')
    if t == 'boolean':
        return 'boolean'
    if t in ('integer', 'number'):
        return 'number'
    if t == 'string':
        return 'text'

    return None


def _key_to_label(key: str) -> str:
    """将 snake_case key 转为可读标签。"""
    return key.replace('_', ' ').title()


def _ensure_root_group(groups: List[Dict[str, Any]], overrides: Dict[str, str]) -> None:
    """确保 groups 列表首位有一个 _root 组（用于顶层标量字段）。"""
    if not groups or groups[0]['key'] != '_root':
        groups.insert(0, {
            'key': '_root',
            'label': overrides.get('_root', '基础配置'),
            'description': '',
            'fields': [],
        })
