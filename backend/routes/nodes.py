# -*- coding: utf-8 -*-
"""
节点系统 API 路由
"""

from flask import Blueprint, request, jsonify
from nodes import init_registry, NodeConfigStore, get_registry

nodes_bp = Blueprint('nodes', __name__, url_prefix='/api/nodes')

# 初始化
_registry = None
_config_store = None


def get_node_registry():
    global _registry
    if _registry is None:
        _registry = init_registry()
    return _registry


def get_config_store():
    global _config_store
    if _config_store is None:
        _config_store = NodeConfigStore()
    return _config_store


# ========== 节点类型 ==========

@nodes_bp.route('/types', methods=['GET'])
def list_node_types():
    """列出所有可用节点类型"""
    registry = get_node_registry()
    definitions = registry.list_all()
    return jsonify({
        "success": True,
        "nodes": [d.model_dump() for d in definitions]
    })


@nodes_bp.route('/types/<node_type>', methods=['GET'])
def get_node_type(node_type):
    """获取节点类型详情"""
    registry = get_node_registry()
    try:
        node_class = registry.get(node_type)
        definition = node_class.get_definition()
        return jsonify({
            "success": True,
            "node": definition.model_dump()
        })
    except KeyError:
        return jsonify({"success": False, "error": f"节点类型 {node_type} 不存在"}), 404


@nodes_bp.route('/types/<node_type>/default-config', methods=['GET'])
def get_default_config(node_type):
    """获取节点默认配置"""
    registry = get_node_registry()
    try:
        node_class = registry.get(node_type)
        config = node_class.get_default_config()
        return jsonify({
            "success": True,
            "config": config.model_dump()
        })
    except KeyError:
        return jsonify({"success": False, "error": f"节点类型 {node_type} 不存在"}), 404


@nodes_bp.route('/data-types', methods=['GET'])
def get_data_types():
    """获取所有节点使用的数据类型
    
    从所有注册的节点中提取 inputs 和 outputs 的 type 字段，
    返回去重后的类型列表，供前端动态生成全局变量类型选项
    """
    registry = get_node_registry()
    definitions = registry.list_all()
    
    # 收集所有类型
    types_set = set()
    
    for definition in definitions:
        # 从输入中提取类型
        for input_def in definition.inputs:
            if 'type' in input_def:
                types_set.add(input_def['type'])
        
        # 从输出中提取类型
        for output_def in definition.outputs:
            if 'type' in output_def:
                types_set.add(output_def['type'])
    
    # 转换为列表并排序
    types_list = sorted(list(types_set))
    
    # 添加常用的通用类型（如果不存在）
    common_types = ['any', 'text', 'string', 'integer', 'number', 'bool', 'json', 'array', 'object']
    for t in common_types:
        if t not in types_set:
            types_list.append(t)
    
    return jsonify({
        "success": True,
        "data": {
            "types": types_list,
            "count": len(types_list),
            "from_nodes": sorted(list(types_set)),  # 来自节点定义的类型
            "additional": [t for t in common_types if t not in types_set]  # 额外添加的通用类型
        }
    })


# ========== 配置管理 ==========

@nodes_bp.route('/configs', methods=['GET'])
def list_configs():
    """列出所有保存的配置"""
    store = get_config_store()
    node_type = request.args.get('node_type')
    include_presets = request.args.get('include_presets', 'true').lower() == 'true'
    
    configs = store.list_configs(node_type, include_presets)
    return jsonify({
        "success": True,
        "configs": [c.model_dump() for c in configs]
    })


@nodes_bp.route('/configs', methods=['POST'])
def save_config():
    """保存节点配置"""
    registry = get_node_registry()
    store = get_config_store()
    data = request.json
    
    node_type = data.get('node_type')
    name = data.get('name')
    config_data = data.get('config', {})
    description = data.get('description', '')
    tags = data.get('tags', [])
    is_preset = data.get('is_preset', False)
    overwrite = data.get('overwrite', False)
    
    # 验证节点类型
    try:
        node_class = registry.get(node_type)
        config_class = node_class.get_config_class()
        config = config_class(**config_data)
    except KeyError:
        return jsonify({"success": False, "error": f"节点类型 {node_type} 不存在"}), 404
    except Exception as e:
        return jsonify({"success": False, "error": f"配置验证失败: {e}"}), 400
    
    # 同名检测（仅实例配置）
    if (not is_preset) and (not overwrite):
        existing = store.find_instance_by_name(node_type, name)
        if existing:
            return jsonify({
                "success": False,
                "error": "配置名称已存在，是否覆盖？",
                "exists": True,
                "config_id": existing["metadata"].id
            }), 409

    config_id = store.save_config(
        node_type=node_type,
        config=config,
        name=name,
        description=description,
        tags=tags,
        is_preset=is_preset,
        overwrite=overwrite
    )
    
    return jsonify({"success": True, "config_id": config_id, "overwritten": overwrite})


@nodes_bp.route('/configs/<config_id>', methods=['GET'])
def get_config(config_id):
    """获取配置详情"""
    store = get_config_store()
    
    data = store.load_config_with_metadata(config_id)
    if data:
        return jsonify({
            "success": True,
            "metadata": data.get("_metadata", {}),
            "config": data.get("config", {})
        })
    return jsonify({"success": False, "error": "配置不存在"}), 404


@nodes_bp.route('/configs/<config_id>', methods=['DELETE'])
def delete_config(config_id):
    """删除配置"""
    store = get_config_store()
    success = store.delete_config(config_id)
    if success:
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "配置不存在"}), 404


# ========== 节点执行 ==========

@nodes_bp.route('/execute', methods=['POST'])
def execute_node():
    """执行节点"""
    registry = get_node_registry()
    store = get_config_store()
    data = request.json
    
    node_type = data.get('node_type')
    config_id = data.get('config_id')
    config_data = data.get('config')
    inputs = data.get('inputs', {})
    
    try:
        node_class = registry.get(node_type)
        node = node_class()
        
        # 加载配置
        if config_id:
            config = store.load_config(config_id, node_class)
            if not config:
                return jsonify({"success": False, "error": "配置不存在"}), 404
            node.configure(config)
        elif config_data:
            node.configure_from_dict(config_data)
        else:
            node.configure(node_class.get_default_config())
        
        # 验证
        errors = node.validate()
        if errors:
            return jsonify({"success": False, "error": "配置验证失败", "details": errors}), 400
        
        # 执行
        outputs = node.execute(inputs)
        
        return jsonify({
            "success": True,
            "outputs": outputs
        })
        
    except KeyError:
        return jsonify({"success": False, "error": f"节点类型 {node_type} 不存在"}), 404
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


# ========== 处理器管理 (json2graph专用) ==========

@nodes_bp.route('/processors/builtin', methods=['GET'])
def list_builtin_processors():
    """列出内置处理器"""
    from nodes.json2graph import Json2GraphNode
    processors = Json2GraphNode.get_builtin_processors()
    return jsonify({
        "success": True,
        "processors": processors
    })
