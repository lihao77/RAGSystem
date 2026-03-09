# -*- coding: utf-8 -*-
"""
地理信息工具函数 - 坐标提取和处理
"""

import re
import logging

logger = logging.getLogger(__name__)

# WKT POINT格式正则表达式
_POINT_PATTERN = re.compile(
    r"^\s*(?:SRID=\d+;\s*)?POINT(?:\s+[A-Z]+)?\s*\(\s*([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)",
    re.IGNORECASE,
)


def extract_coordinates_from_geometry(geometry_value):
    """
    从几何对象中提取经纬度坐标
    
    注意：此函数只提取POINT类型的坐标，POLYGON/MULTIPOLYGON会返回None
    这是设计意图：
    - POINT数据：提取longitude/latitude用于定位
    - POLYGON数据：保持原始geometry用于前端渲染边界
    
    支持的格式：
    - WKT POINT: "POINT(lon lat)" 或 "SRID=4326;POINT(lon lat)"
    - 简单字符串: "lon,lat"
    - 字典: {'coordinates': [lon, lat]}
    - 列表/元组: [lon, lat]
    
    Args:
        geometry_value: 几何对象（字符串、字典、列表或元组）
        
    Returns:
        tuple: (longitude, latitude) 如果提取成功，否则 (None, None)
    """
    if not geometry_value:
        return None, None

    # 处理字符串格式
    if isinstance(geometry_value, str):
        text = geometry_value.strip()
        
        # 只匹配WKT POINT格式（不处理POLYGON/MULTIPOLYGON）
        match = _POINT_PATTERN.match(text)
        if match:
            try:
                return float(match.group(1)), float(match.group(2))
            except ValueError:
                logger.warning(f'WKT POINT坐标转换失败: {text}')
                return None, None

        # 尝试解析简单的 "lon,lat" 格式
        if ',' in text and text.count(',') == 1:
            left, right = text.split(',', 1)
            try:
                return float(left.strip()), float(right.strip())
            except ValueError:
                logger.warning(f'简单坐标格式转换失败: {text}')
                return None, None

    # 处理字典格式 (GeoJSON style)
    if isinstance(geometry_value, dict):
        coords = geometry_value.get('coordinates')
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            try:
                return float(coords[0]), float(coords[1])
            except (TypeError, ValueError):
                logger.warning(f'字典坐标转换失败: {geometry_value}')
                return None, None

    # 处理列表/元组格式
    if isinstance(geometry_value, (list, tuple)) and len(geometry_value) >= 2:
        try:
            return float(geometry_value[0]), float(geometry_value[1])
        except (TypeError, ValueError):
            logger.warning(f'列表坐标转换失败: {geometry_value}')
            return None, None

    return None, None


def add_coordinates_to_entity(entity, geometry_value):
    """
    将坐标添加到实体对象中
    
    Args:
        entity: 实体字典对象
        geometry_value: 几何对象
        
    Returns:
        None (直接修改entity对象)
    """
    lon, lat = extract_coordinates_from_geometry(geometry_value)
    if lon is not None and lat is not None:
        entity['longitude'] = lon
        entity['latitude'] = lat


def validate_coordinates(lon, lat):
    """
    验证坐标是否合法
    
    Args:
        lon: 经度
        lat: 纬度
        
    Returns:
        bool: 坐标是否合法
    """
    try:
        lon_f = float(lon)
        lat_f = float(lat)
        # 经度范围: -180 到 180
        # 纬度范围: -90 到 90
        return -180 <= lon_f <= 180 and -90 <= lat_f <= 90
    except (TypeError, ValueError):
        return False


def format_coordinates(lon, lat, precision=6):
    """
    格式化坐标为字符串
    
    Args:
        lon: 经度
        lat: 纬度
        precision: 小数精度（默认6位）
        
    Returns:
        str: 格式化后的坐标字符串 "lon,lat"
    """
    try:
        lon_f = float(lon)
        lat_f = float(lat)
        return f"{lon_f:.{precision}f},{lat_f:.{precision}f}"
    except (TypeError, ValueError):
        return None
