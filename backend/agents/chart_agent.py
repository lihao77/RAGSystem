# -*- coding: utf-8 -*-
"""
ChartAgent - 图表生成智能代理

基于数据结构和问题语义自动生成 ECharts 配置
支持折线图、柱状图、饼图、散点图等多种图表类型
"""

import logging
from typing import Dict, List, Any, Optional
import json

logger = logging.getLogger(__name__)


class ChartAgent:
    """
    图表生成代理
    
    核心功能：
    1. 分析数据结构，自动选择最佳图表类型
    2. 生成完整的 ECharts 配置对象
    3. 支持时序数据、对比数据、分布数据等多种场景
    4. 智能格式化数值、日期等数据
    """
    
    # 支持的图表类型
    CHART_TYPES = {
        'line': '折线图',
        'bar': '柱状图',
        'pie': '饼图',
        'scatter': '散点图',
        'radar': '雷达图',
        'heatmap': '热力图',
        'graph': '关系图'
    }
    
    def __init__(self):
        """初始化 ChartAgent"""
        self.logger = logging.getLogger(self.__class__.__name__)
    
    def generate_chart(
        self,
        data: List[Dict[str, Any]],
        question: str = "",
        chart_type: Optional[str] = None,
        title: str = "",
        x_field: str = "",
        y_field: str = "",
        series_field: str = ""
    ) -> Dict[str, Any]:
        """
        生成图表配置
        
        Args:
            data: 数据列表，每个元素是一个字典
            question: 原始问题（用于智能选择图表类型）
            chart_type: 指定图表类型（可选），不指定则自动选择
            title: 图表标题（可选）
            x_field: X轴字段名（用于line/bar/scatter）
            y_field: Y轴字段名（用于line/bar/scatter）
            series_field: 系列字段名（用于多系列图表）
        
        Returns:
            {
                "success": True/False,
                "chart_type": "折线图/柱状图/...",
                "echarts_config": {...},  # ECharts 配置对象
                "data_summary": {...},     # 数据摘要
                "message": "..."
            }
        """
        try:
            # 数据验证
            if not data or len(data) == 0:
                return {
                    "success": False,
                    "error": "数据为空，无法生成图表"
                }
            
            # 1. 自动选择图表类型
            if not chart_type:
                chart_type = self._auto_select_chart_type(data, question, x_field, y_field)
            
            # 2. 生成图表标题
            if not title:
                title = self._generate_title(question, chart_type, data)
            
            # 3. 数据预处理
            processed_data = self._preprocess_data(data, chart_type, x_field, y_field, series_field)
            
            # 4. 生成 ECharts 配置
            echarts_config = self._generate_echarts_config(
                chart_type=chart_type,
                title=title,
                data=processed_data,
                x_field=x_field,
                y_field=y_field,
                series_field=series_field
            )
            
            # 5. 生成数据摘要
            data_summary = self._generate_data_summary(data, chart_type)
            
            return {
                "success": True,
                "chart_type": self.CHART_TYPES.get(chart_type, chart_type),
                "echarts_config": echarts_config,
                "data_summary": data_summary,
                "message": f"成功生成{self.CHART_TYPES.get(chart_type, chart_type)}，包含 {len(data)} 条数据"
            }
        
        except Exception as e:
            self.logger.error(f"生成图表失败: {e}", exc_info=True)
            return {
                "success": False,
                "error": f"生成图表失败: {str(e)}"
            }
    
    def _auto_select_chart_type(
        self,
        data: List[Dict],
        question: str,
        x_field: str,
        y_field: str
    ) -> str:
        """
        根据数据结构和问题自动选择图表类型
        
        策略：
        1. 关键词匹配（趋势、变化 → 折线图；对比 → 柱状图；占比 → 饼图）
        2. 数据结构分析（时间序列 → 折线图；类别数据 → 柱状图）
        3. 字段类型判断（数值型、日期型、类别型）
        """
        question_lower = question.lower()
        
        # 关键词匹配
        if any(kw in question_lower for kw in ['趋势', '变化', '演化', '发展', '增长', '下降']):
            return 'line'
        
        if any(kw in question_lower for kw in ['对比', '比较', '排名', 'top']):
            return 'bar'
        
        if any(kw in question_lower for kw in ['占比', '比例', '分布', '构成']):
            return 'pie'
        
        if any(kw in question_lower for kw in ['关系', '相关', '散点']):
            return 'scatter'
        
        # 数据结构分析
        if len(data) > 0:
            first_item = data[0]
            
            # 检查是否有时间字段
            time_fields = ['time', 'date', 'datetime', 'year', 'month', 'day', '日期', '时间']
            has_time = any(field in str(first_item.keys()).lower() for field in time_fields)
            
            if has_time and len(data) >= 3:
                return 'line'  # 时间序列用折线图
            
            # 检查数据量
            if len(data) <= 10:
                # 数据少，适合饼图或柱状图
                if len(first_item) == 2:  # 只有名称和值，适合饼图
                    return 'pie'
                return 'bar'
            else:
                # 数据多，用折线图
                return 'line'
        
        # 默认柱状图
        return 'bar'
    
    def _generate_title(self, question: str, chart_type: str, data: List[Dict]) -> str:
        """生成图表标题"""
        if question:
            # 提取问题中的关键信息
            return question.replace('？', '').replace('?', '').strip()
        
        chart_name = self.CHART_TYPES.get(chart_type, '图表')
        return f"数据{chart_name}（{len(data)}条记录）"
    
    def _preprocess_data(
        self,
        data: List[Dict],
        chart_type: str,
        x_field: str,
        y_field: str,
        series_field: str
    ) -> Dict[str, Any]:
        """
        数据预处理
        
        根据图表类型整理数据结构：
        - line/bar: {x_data: [], y_data: [], series: []}
        - pie: {data: [{name: '', value: 0}]}
        - scatter: {data: [[x, y], [x, y], ...]}
        """
        processed = {}
        
        if chart_type in ['line', 'bar']:
            # 提取 X 和 Y 轴数据
            x_data = []
            y_data = []
            series_data = {}
            
            # 自动识别字段
            if not x_field or not y_field:
                keys = list(data[0].keys())
                if len(keys) >= 2:
                    x_field = x_field or keys[0]
                    y_field = y_field or keys[1]
            
            for item in data:
                x_val = item.get(x_field, '')
                y_val = item.get(y_field, 0)
                
                # 格式化数值
                if isinstance(y_val, (int, float)):
                    y_val = round(y_val, 2)
                
                if series_field and series_field in item:
                    series_name = item[series_field]
                    if series_name not in series_data:
                        series_data[series_name] = []
                    series_data[series_name].append(y_val)
                    if x_val not in x_data:
                        x_data.append(x_val)
                else:
                    x_data.append(x_val)
                    y_data.append(y_val)
            
            processed['x_data'] = x_data
            processed['y_data'] = y_data
            processed['series'] = series_data if series_data else None
            processed['x_field'] = x_field
            processed['y_field'] = y_field
        
        elif chart_type == 'pie':
            # 饼图数据
            pie_data = []
            
            # 自动识别名称和值字段
            keys = list(data[0].keys())
            name_field = keys[0]
            value_field = keys[1] if len(keys) > 1 else keys[0]
            
            for item in data:
                name = item.get(name_field, '未知')
                value = item.get(value_field, 0)
                
                if isinstance(value, (int, float)):
                    value = round(value, 2)
                
                pie_data.append({
                    'name': str(name),
                    'value': value
                })
            
            processed['data'] = pie_data
        
        elif chart_type == 'scatter':
            # 散点图数据
            scatter_data = []
            
            # 自动识别 X 和 Y 字段
            if not x_field or not y_field:
                keys = list(data[0].keys())
                if len(keys) >= 2:
                    x_field = keys[0]
                    y_field = keys[1]
            
            for item in data:
                x_val = item.get(x_field, 0)
                y_val = item.get(y_field, 0)
                scatter_data.append([x_val, y_val])
            
            processed['data'] = scatter_data
            processed['x_field'] = x_field
            processed['y_field'] = y_field
        
        return processed
    
    def _generate_echarts_config(
        self,
        chart_type: str,
        title: str,
        data: Dict[str, Any],
        x_field: str,
        y_field: str,
        series_field: str
    ) -> Dict[str, Any]:
        """
        生成 ECharts 配置对象
        
        根据图表类型生成完整的 ECharts option
        """
        base_config = {
            'title': {
                'text': title,
                'left': 'center',
                'top': 10,
                'textStyle': {
                    'fontSize': 18,
                    'fontWeight': 'bold'
                }
            },
            'tooltip': {
                'trigger': 'axis' if chart_type in ['line', 'bar'] else 'item',
                'axisPointer': {
                    'type': 'shadow'
                }
            },
            'legend': {
                'top': 50,
                'left': 'center'
            },
            'grid': {
                'left': '10%',
                'right': '10%',
                'bottom': '15%',
                'top': 100,
                'containLabel': True
            },
            'toolbox': {
                'feature': {
                    'saveAsImage': {'title': '保存为图片'},
                    'dataView': {'title': '数据视图', 'readOnly': True},
                    'restore': {'title': '还原'},
                    'dataZoom': {'title': {'zoom': '区域缩放', 'back': '还原缩放'}}
                },
                'right': 20,
                'top': 10
            }
        }
        
        if chart_type == 'line':
            # 折线图
            config = {**base_config}
            config['xAxis'] = {
                'type': 'category',
                'data': data['x_data'],
                'name': data.get('x_field', ''),
                'axisLabel': {
                    'rotate': 45 if len(data['x_data']) > 10 else 0
                }
            }
            config['yAxis'] = {
                'type': 'value',
                'name': data.get('y_field', '')
            }
            
            if data.get('series'):
                # 多系列
                config['series'] = []
                for series_name, series_values in data['series'].items():
                    config['series'].append({
                        'name': series_name,
                        'type': 'line',
                        'data': series_values,
                        'smooth': True,
                        'emphasis': {'focus': 'series'}
                    })
            else:
                # 单系列
                config['series'] = [{
                    'name': data.get('y_field', '数值'),
                    'type': 'line',
                    'data': data['y_data'],
                    'smooth': True,
                    'areaStyle': {'opacity': 0.3},
                    'emphasis': {'focus': 'series'}
                }]
        
        elif chart_type == 'bar':
            # 柱状图
            config = {**base_config}
            config['xAxis'] = {
                'type': 'category',
                'data': data['x_data'],
                'name': data.get('x_field', ''),
                'axisLabel': {
                    'rotate': 45 if len(data['x_data']) > 10 else 0
                }
            }
            config['yAxis'] = {
                'type': 'value',
                'name': data.get('y_field', '')
            }
            
            if data.get('series'):
                # 多系列
                config['series'] = []
                for series_name, series_values in data['series'].items():
                    config['series'].append({
                        'name': series_name,
                        'type': 'bar',
                        'data': series_values,
                        'emphasis': {'focus': 'series'}
                    })
            else:
                # 单系列
                config['series'] = [{
                    'name': data.get('y_field', '数值'),
                    'type': 'bar',
                    'data': data['y_data'],
                    'emphasis': {'focus': 'series'},
                    'itemStyle': {
                        'color': '#5470c6'
                    }
                }]
        
        elif chart_type == 'pie':
            # 饼图
            config = {**base_config}
            config['tooltip']['trigger'] = 'item'
            config['tooltip']['formatter'] = '{a} <br/>{b}: {c} ({d}%)'
            config['series'] = [{
                'name': '数据',
                'type': 'pie',
                'radius': '60%',
                'center': ['50%', '55%'],
                'data': data['data'],
                'emphasis': {
                    'itemStyle': {
                        'shadowBlur': 10,
                        'shadowOffsetX': 0,
                        'shadowColor': 'rgba(0, 0, 0, 0.5)'
                    }
                },
                'label': {
                    'formatter': '{b}: {d}%'
                }
            }]
            # 饼图不需要 xAxis 和 yAxis
            config.pop('xAxis', None)
            config.pop('yAxis', None)
            config.pop('grid', None)
        
        elif chart_type == 'scatter':
            # 散点图
            config = {**base_config}
            config['xAxis'] = {
                'type': 'value',
                'name': data.get('x_field', 'X')
            }
            config['yAxis'] = {
                'type': 'value',
                'name': data.get('y_field', 'Y')
            }
            config['series'] = [{
                'name': '数据点',
                'type': 'scatter',
                'data': data['data'],
                'symbolSize': 10,
                'emphasis': {'focus': 'series'}
            }]
        
        return config
    
    def _generate_data_summary(self, data: List[Dict], chart_type: str) -> Dict[str, Any]:
        """
        生成数据摘要
        
        包含数据统计信息：总数、数值范围、平均值等
        """
        summary = {
            'total_records': len(data),
            'chart_type': self.CHART_TYPES.get(chart_type, chart_type)
        }
        
        if len(data) > 0:
            # 提取所有数值字段
            numeric_fields = []
            first_item = data[0]
            
            for key, value in first_item.items():
                if isinstance(value, (int, float)):
                    numeric_fields.append(key)
            
            # 计算统计信息
            for field in numeric_fields:
                values = [item.get(field, 0) for item in data if isinstance(item.get(field), (int, float))]
                
                if values:
                    summary[field] = {
                        'min': round(min(values), 2),
                        'max': round(max(values), 2),
                        'avg': round(sum(values) / len(values), 2),
                        'sum': round(sum(values), 2)
                    }
        
        return summary
    
    def suggest_chart_type(self, data: List[Dict], question: str = "") -> List[Dict[str, Any]]:
        """
        为数据推荐合适的图表类型
        
        Returns:
            [
                {"type": "line", "name": "折线图", "score": 0.9, "reason": "..."},
                {"type": "bar", "name": "柱状图", "score": 0.7, "reason": "..."},
                ...
            ]
        """
        suggestions = []
        
        # 分析数据特征
        has_time = False
        numeric_count = 0
        category_count = 0
        
        if len(data) > 0:
            first_item = data[0]
            for key, value in first_item.items():
                if any(kw in key.lower() for kw in ['time', 'date', 'year', 'month', '时间', '日期']):
                    has_time = True
                
                if isinstance(value, (int, float)):
                    numeric_count += 1
                else:
                    category_count += 1
        
        # 评分规则
        if has_time and len(data) >= 3:
            suggestions.append({
                'type': 'line',
                'name': '折线图',
                'score': 0.9,
                'reason': '数据包含时间序列，适合展示趋势变化'
            })
        
        if len(data) <= 20:
            suggestions.append({
                'type': 'bar',
                'name': '柱状图',
                'score': 0.8,
                'reason': '数据量适中，适合类别对比'
            })
        
        if len(data) <= 10 and category_count > 0:
            suggestions.append({
                'type': 'pie',
                'name': '饼图',
                'score': 0.7,
                'reason': '数据量少且有分类，适合展示占比'
            })
        
        if numeric_count >= 2:
            suggestions.append({
                'type': 'scatter',
                'name': '散点图',
                'score': 0.6,
                'reason': '包含多个数值字段，适合分析相关性'
            })
        
        # 按得分排序
        suggestions.sort(key=lambda x: x['score'], reverse=True)
        
        return suggestions
