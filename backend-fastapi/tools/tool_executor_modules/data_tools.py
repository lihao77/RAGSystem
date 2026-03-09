# -*- coding: utf-8 -*-
"""
data_tools 工具模块。
"""

import logging
from .shared import error_response, success_response

logger = logging.getLogger(__name__)

def transform_data(python_code, description=""):
    """
    执行 Python 代码进行数据转换（纯内存操作）

    适用于 LLM 已经从前一个工具获得数据，需要快速转换的场景。
    LLM 直接在代码中硬编码数据，无需传递 data 参数。

    Args:
        python_code: Python 转换代码，必须设置 result 变量作为输出
        description: 操作描述（可选）

    Returns:
        标准化响应:
        {
            "success": True,
            "data": {
                "results": [...],  # 转换后的数据（从 result 变量获取）
                "metadata": {...},  # 自动生成
                "summary": "数据转换成功"
            }
        }

    Example:
        python_code = '''
# 直接在代码中定义数据
raw_data = [
    {"name": "南宁", "lng": 108.37, "lat": 22.82, "value": 1500},
    {"name": "柳州", "lng": 109.42, "lat": 24.33, "value": 800}
]

# 转换数据
result = []
for item in raw_data:
    result.append({
        'name': item['name'],
        'value': item['value'],
        'geometry': f"POINT ({item['lng']} {item['lat']})"
    })
'''
        transform_data(python_code, "添加 geometry 字段")
    """
    import pandas as pd
    import json

    try:
        logger.info(f"执行数据转换: {description}")

        # 参数验证
        if not python_code or not python_code.strip():
            return error_response("参数 python_code 不能为空")

        # 准备执行环境
        local_vars = {
            'pd': pd,
            'json': json,
            'result': None,    # 输出结果（用户必须设置）
            '__builtins__': __builtins__
        }

        # 安全限制：禁止导入敏感模块
        forbidden_modules = ['os', 'sys', 'subprocess', 'shutil']
        for mod in forbidden_modules:
            if f"import {mod}" in python_code or f"from {mod}" in python_code:
                return error_response(f"安全警告: 禁止在代码中使用 {mod} 模块")

        # 执行代码
        logger.info("开始执行转换代码...")
        exec(python_code, local_vars, local_vars)

        # 获取结果
        result_data = local_vars.get('result')
        if result_data is None:
            return error_response(
                "代码执行成功，但未设置 result 变量。\n"
                "请在代码末尾添加：result = <转换后的数据>"
            )

        # 使用标准化响应（自动生成元数据）
        return success_response(
            results=result_data,
            summary=f"数据转换成功：{description}" if description else "数据转换成功"
        )

    except Exception as e:
        logger.error(f"数据转换失败: {e}")
        import traceback
        logger.error(traceback.format_exc())
        return error_response(f"数据转换失败: {str(e)}")

def process_data_file(source_path, python_code, description=""):
    """
    执行数据处理工具

    Args:
        source_path: 源文件路径
        python_code: Python 处理代码
        description: 操作描述

    Returns:
        标准化响应（自动生成元数据和摘要）:
        {
            "success": True,
            "data": {
                "results": list,         # 处理后的数据列表
                "metadata": {            # 自动生成
                    "total_count": int,
                    "fields": list,
                    "sample": dict
                },
                "summary": str,          # 自动生成
                "debug": {
                    "result_path": str,
                    "source_path": str,
                    "file_size": str
                }
            }
        }
    """
    import pandas as pd
    import json
    import os
    import uuid

    try:
        logger.info(f"执行数据处理: {description}")
        logger.info(f"源文件: {source_path}")

        # 1. 验证源文件存在
        if not os.path.exists(source_path):
            return error_response(f"源文件不存在: {source_path}")

        # 2. 生成结果文件路径
        result_dir = os.path.dirname(source_path)
        result_filename = f"processed_{uuid.uuid4().hex}.json"
        result_path = os.path.join(result_dir, result_filename)

        # 3. 准备执行环境
        local_vars = {
            'pd': pd,
            'json': json,
            'source_path': source_path,
            'result_path': result_path,
            '__builtins__': __builtins__
        }

        # 4. 安全限制：禁止导入敏感模块
        forbidden_modules = ['os', 'sys', 'subprocess', 'shutil']
        for mod in forbidden_modules:
            if f"import {mod}" in python_code or f"from {mod}" in python_code:
                return error_response(f"安全警告: 禁止在代码中使用 {mod} 模块")

        # 5. 执行代码
        logger.info("开始执行 Python 代码...")
        exec(python_code, local_vars, local_vars)

        # 6. 验证结果文件是否生成
        if not os.path.exists(result_path):
            return error_response("代码执行成功，但未生成结果文件。请检查代码是否正确写入 result_path。")

        # 7. 读取处理后的完整数据
        file_size = os.path.getsize(result_path)

        # 尝试读取结果文件，支持 JSON 和 CSV 格式
        try:
            with open(result_path, 'r', encoding='utf-8') as f:
                processed_data = json.load(f)
        except json.JSONDecodeError:
            # 如果不是 JSON，尝试作为 CSV 读取
            try:
                df = pd.read_csv(result_path)
                processed_data = df.to_dict('records')
                logger.info(f"结果文件是 CSV 格式，已转换为 {len(processed_data)} 条记录")
            except Exception as csv_error:
                # 如果也不是 CSV，尝试作为文本读取
                with open(result_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    logger.warning(f"结果文件既不是 JSON 也不是 CSV，返回原始文本（前500字符）")
                    return error_response(f"结果文件格式不支持。请确保代码将数据保存为 JSON 格式（使用 json.dump）。\n文件内容预览：{content[:500]}")

        # 8. 使用标准化响应，自动生成元数据和摘要
        # 直接传递处理后的数据，让 success_response 自动分析
        debug_info = {
            "result_path": result_path,
            "source_path": source_path,
            "file_size": f"{file_size / 1024:.2f} KB"
        }

        return success_response(
            results=processed_data,
            debug=debug_info
        )

    except Exception as e:
        logger.error(f"数据处理失败: {e}")
        import traceback
        traceback.print_exc()
        return error_response(f"代码执行错误: {str(e)}")
