#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
数据验证脚本

功能：验证灾害数据的完整性和合理性
用法：python scripts/validate_data.py
"""

import sys
import json
from datetime import datetime


def validate_disaster_data(data):
    """
    验证灾害数据

    Args:
        data: 灾害数据字典

    Returns:
        (bool, list): (是否通过, 错误信息列表)
    """
    errors = []

    # 1. 检查必需字段
    required_fields = ['disaster_name', 'start_date', 'location']
    for field in required_fields:
        if field not in data:
            errors.append(f"缺少必需字段: {field}")

    # 2. 检查时间格式
    if 'start_date' in data:
        try:
            datetime.strptime(data['start_date'], '%Y-%m-%d')
        except ValueError:
            errors.append(f"时间格式错误: {data['start_date']} (应为 YYYY-MM-DD)")

    # 3. 检查数值范围
    if 'affected_population' in data:
        pop = data['affected_population']
        if not isinstance(pop, (int, float)) or pop < 0:
            errors.append(f"受灾人口数值不合理: {pop}")

    if 'economic_loss' in data:
        loss = data['economic_loss']
        if not isinstance(loss, (int, float)) or loss < 0:
            errors.append(f"经济损失数值不合理: {loss}")

    # 4. 检查地理信息
    if 'location' in data:
        location = data['location']
        if not isinstance(location, str) or len(location) == 0:
            errors.append("地理位置信息无效")

    return len(errors) == 0, errors


def main():
    """主函数"""
    print("=" * 60)
    print("灾害数据验证脚本")
    print("=" * 60)

    # 示例数据（实际使用时从参数或标准输入读取）
    sample_data = {
        "disaster_name": "2023年广西洪涝灾害",
        "start_date": "2023-06-01",
        "location": "广西壮族自治区",
        "affected_population": 528800,
        "economic_loss": 3.9
    }

    print("\n正在验证数据...")
    print(json.dumps(sample_data, ensure_ascii=False, indent=2))

    is_valid, errors = validate_disaster_data(sample_data)

    print("\n" + "=" * 60)
    if is_valid:
        print("✓ 数据验证通过")
        print("=" * 60)
        return 0
    else:
        print("✗ 数据验证失败，发现以下问题：")
        for i, error in enumerate(errors, 1):
            print(f"  {i}. {error}")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
