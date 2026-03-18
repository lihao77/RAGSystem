# -*- coding: utf-8 -*-
"""
report_tools.py - 应急报告自动生成工具。

支持三种报告模板：
- flood_bulletin（汛情快报）
- disaster_report（灾情报告）
- situation_report（综合态势报告）
"""

import json
from datetime import datetime
from typing import Any

from tools.decorators import tool
from tools.permissions import RiskLevel
from tools.response_builder import error_result, success_result


def _safe_parse(value) -> Any:
    """安全解析 JSON 字符串为 dict/list/str，已是 dict/list 则直接返回。"""
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _normalize_report_type(report_type: str) -> str:
    """支持中文报告类型别名，统一映射为内部枚举值。"""
    aliases = {
        "flood_bulletin": "flood_bulletin",
        "汛情快报": "flood_bulletin",
        "disaster_report": "disaster_report",
        "灾情报告": "disaster_report",
        "situation_report": "situation_report",
        "综合态势报告": "situation_report",
    }
    if not isinstance(report_type, str):
        return report_type
    return aliases.get(report_type.strip(), report_type)


def _normalize_extra_sections(extra) -> dict:
    """将额外章节统一为 {标题: 内容} 的映射，兼容列表输入。"""
    if not extra:
        return {}
    if isinstance(extra, dict):
        return extra
    if isinstance(extra, list):
        normalized = {}
        for idx, item in enumerate(extra, start=1):
            if isinstance(item, dict):
                title = (
                    item.get("title")
                    or item.get("name")
                    or item.get("section")
                    or item.get("header")
                )
                content = (
                    item.get("content")
                    or item.get("text")
                    or item.get("body")
                    or item.get("value")
                )
                if title:
                    normalized[str(title)] = content if content not in (None, "") else item
                else:
                    normalized[f"补充信息{idx}"] = item
            else:
                normalized[f"补充信息{idx}"] = item
        return normalized
    return {"补充信息": extra}


def _section(title: str, content) -> str:
    """生成 Markdown 章节。"""
    if not content:
        return f"### {title}\n\n暂无数据\n"
    if isinstance(content, list):
        lines = "\n".join(f"- {item}" for item in content)
        return f"### {title}\n\n{lines}\n"
    return f"### {title}\n\n{content}\n"


def _format_weather(weather: dict) -> str:
    """格式化天气数据为文本。"""
    if not weather:
        return ""
    parts = []
    if weather.get("rainfall_24h_mm"):
        parts.append(f"24小时累计降雨量: {weather['rainfall_24h_mm']}mm")
    if weather.get("forecast_rainfall_mm"):
        parts.append(f"未来24小时预报降雨量: {weather['forecast_rainfall_mm']}mm")
    if weather.get("temp_c"):
        parts.append(f"气温: {weather['temp_c']}°C")
    return "；".join(parts) if parts else str(weather)


def _format_warnings(warning: dict) -> str:
    """格式化预警数据为文本。"""
    if not warning:
        return ""
    warnings = warning.get("warnings", [])
    if isinstance(warning, list):
        warnings = warning
    if not warnings:
        stat = warning.get("stat", {})
        if stat:
            return f"当前预警统计: {json.dumps(stat, ensure_ascii=False)}"
        return ""
    lines = []
    for w in warnings[:10]:
        line = w.get("title", "")
        if w.get("issued_at"):
            line += f" ({w['issued_at']})"
        lines.append(line)
    return "\n".join(f"- {l}" for l in lines)


def _format_risk(risk: dict) -> str:
    """格式化风险评估数据。"""
    if not risk:
        return ""
    parts = []
    if risk.get("risk_level"):
        parts.append(f"风险等级: {risk['risk_level']}级 ({risk.get('risk_label', '')})")
    if risk.get("risk_factors"):
        factors = risk["risk_factors"]
        if isinstance(factors, list):
            parts.append("风险因素: " + "、".join(factors))
    if risk.get("assessment"):
        parts.append(f"评估结论: {risk['assessment']}")
    return "\n\n".join(parts) if parts else str(risk)


def _build_flood_bulletin(title: str, location: str, report_time: str,
                          situation: dict, risk: dict, warning: dict,
                          plan: dict, action: dict, weather: dict,
                          extra: dict) -> str:
    """汛情快报模板。"""
    md = f"# {title}\n\n"
    md += f"**报告时间：** {report_time}　**区域：** {location}\n\n---\n\n"
    md += _section("一、基本情况", situation.get("summary") or situation.get("description") or (str(situation) if situation else ""))
    md += "\n"
    weather_text = _format_weather(weather) or situation.get("weather", "")
    md += _section("二、雨情水情", weather_text)
    md += "\n"
    md += _section("三、预警信息", _format_warnings(warning))
    md += "\n"
    md += _section("四、风险评估", _format_risk(risk))
    md += "\n"
    action_text = ""
    if action:
        items = action.get("key_actions") or action.get("actions") or action.get("measures")
        action_text = items if isinstance(items, list) else str(action) if action else ""
    md += _section("五、已采取措施", action_text)
    md += "\n"
    plan_text = ""
    if plan:
        plan_text = plan.get("suggestions") or plan.get("next_steps") or plan.get("recommendations") or str(plan)
    md += _section("六、下一步建议", plan_text)
    if extra:
        for k, v in extra.items():
            md += "\n" + _section(k, v)
    return md


def _build_disaster_report(title: str, location: str, report_time: str,
                           situation: dict, risk: dict, warning: dict,
                           plan: dict, action: dict, weather: dict,
                           extra: dict) -> str:
    """灾情报告模板。"""
    md = f"# {title}\n\n"
    md += f"**报告时间：** {report_time}　**区域：** {location}\n\n---\n\n"
    md += _section("一、灾情概述", situation.get("summary") or situation.get("description") or (str(situation) if situation else ""))
    md += "\n"
    affected = situation.get("affected") or situation.get("casualties") or situation.get("damage")
    md += _section("二、受灾情况", str(affected) if affected else "")
    md += "\n"
    response = action.get("response") or action.get("emergency_response") or ""
    if not response and action:
        response = str(action)
    md += _section("三、应急响应", response)
    md += "\n"
    rescue = action.get("rescue") or action.get("progress") or ""
    md += _section("四、救援进展", rescue)
    md += "\n"
    needs = plan.get("needs") or plan.get("requirements") or plan.get("demand_list") or ""
    if isinstance(needs, dict):
        needs = "\n".join(f"- {k}: {v}" for k, v in needs.items())
    md += _section("五、需求清单", needs)
    if extra:
        for k, v in extra.items():
            md += "\n" + _section(k, v)
    return md


def _build_situation_report(title: str, location: str, report_time: str,
                            situation: dict, risk: dict, warning: dict,
                            plan: dict, action: dict, weather: dict,
                            extra: dict) -> str:
    """综合态势报告模板。"""
    md = f"# {title}\n\n"
    md += f"**报告时间：** {report_time}　**区域：** {location}\n\n---\n\n"
    overview = situation.get("summary") or situation.get("overview") or (str(situation) if situation else "")
    md += _section("一、态势概览", overview)
    md += "\n"
    md += _section("二、气象预警", _format_warnings(warning))
    md += "\n"
    focus = situation.get("focus_areas") or situation.get("key_areas") or ""
    if isinstance(focus, list):
        focus = "\n".join(f"- {a}" for a in focus)
    md += _section("三、重点区域分析", focus if focus else _format_weather(weather))
    md += "\n"
    md += _section("四、风险研判", _format_risk(risk))
    md += "\n"
    plan_text = ""
    if plan:
        plan_text = plan.get("matched_plans") or plan.get("plan_references") or str(plan)
        if isinstance(plan_text, list):
            plan_text = "\n".join(
                f"- {p}" if isinstance(p, str) else f"- {p.get('text', str(p))}"
                for p in plan_text
            )
    md += _section("五、预案匹配", plan_text)
    md += "\n"
    action_text = ""
    if action:
        items = action.get("key_actions") or action.get("suggestions") or action.get("recommendations")
        action_text = items if isinstance(items, list) else str(action) if action else ""
    md += _section("六、行动建议", action_text)
    if extra:
        for k, v in extra.items():
            md += "\n" + _section(k, v)
    return md


_TEMPLATE_BUILDERS = {
    "flood_bulletin": _build_flood_bulletin,
    "disaster_report": _build_disaster_report,
    "situation_report": _build_situation_report,
}

_DEFAULT_TITLES = {
    "flood_bulletin": "汛情快报",
    "disaster_report": "灾情报告",
    "situation_report": "综合态势报告",
}


@tool(
    name="generate_report",
    description=(
        "生成标准格式应急报告并返回 Markdown。"
        "report_type 必须优先使用英文枚举值："
        "flood_bulletin=汛情快报，disaster_report=灾情报告，"
        "situation_report=综合态势报告。"
        "各 data 参数优先传结构化 JSON 对象；extra_sections 必须是“章节名 -> 内容”的对象，"
        "不要传普通列表。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "report_type": {
                "type": "string",
                "description": (
                    "报告类型枚举。推荐直接传英文值："
                    "flood_bulletin（汛情快报）、"
                    "disaster_report（灾情报告）、"
                    "situation_report（综合态势报告）。"
                    "不要把中文名称当作正式枚举值传入。"
                ),
                "enum": ["flood_bulletin", "disaster_report", "situation_report"],
            },
            "title": {"type": "string", "description": "报告标题（可选）"},
            "location": {"type": "string", "description": "区域"},
            "situation_data": {
                "oneOf": [{"type": "string"}, {"type": "object"}],
                "description": (
                    "态势/灾情主数据。优先传对象，常用字段：summary、description、overview、"
                    "focus_areas、affected、casualties、damage。"
                ),
            },
            "risk_data": {
                "oneOf": [{"type": "string"}, {"type": "object"}],
                "description": (
                    "风险评估数据。优先传对象，常用字段：risk_level、risk_label、"
                    "risk_factors、assessment。"
                ),
            },
            "warning_data": {
                "oneOf": [{"type": "string"}, {"type": "object"}, {"type": "array"}],
                "description": (
                    "预警数据。可传对象或数组。推荐对象形态："
                    "{warnings:[{title,issued_at}], stat:{...}}。"
                ),
            },
            "plan_data": {
                "oneOf": [{"type": "string"}, {"type": "object"}, {"type": "array"}],
                "description": (
                    "预案/建议数据。推荐对象形态，常用字段：suggestions、next_steps、"
                    "recommendations、matched_plans、plan_references、needs。"
                ),
            },
            "action_data": {
                "oneOf": [{"type": "string"}, {"type": "object"}, {"type": "array"}],
                "description": (
                    "行动/响应数据。推荐对象形态，常用字段：key_actions、actions、"
                    "measures、response、rescue、progress。"
                ),
            },
            "weather_data": {
                "oneOf": [{"type": "string"}, {"type": "object"}],
                "description": (
                    "气象数据。推荐对象形态，常用字段：rainfall_24h_mm、"
                    "forecast_rainfall_mm、temp_c。"
                ),
            },
            "extra_sections": {
                "oneOf": [{"type": "string"}, {"type": "object"}, {"type": "array"}],
                "description": (
                    "额外章节。推荐传对象，如 "
                    "{\"七、值班安排\":\"...\",\"八、需协调事项\":[\"...\",\"...\"]}。"
                    "如果传数组，数组元素应尽量使用 {title, content} 结构。"
                ),
            },
            "report_time": {"type": "string", "description": "报告时间，格式 YYYY-MM-DD HH:MM"},
        },
        "required": ["report_type"],
    },
    risk_level=RiskLevel.LOW,
    requires_approval=False,
    timeout_seconds=120,
    allowed_callers=["direct"],
    returns={
        "type": "object",
        "description": "生成后的报告对象",
        "shape": {
            "report_type": "string",
            "title": "string",
            "location": "string",
            "report_time": "string",
            "sections": {
                "situation": "object|array|string",
                "risk": "object|array|string",
                "warning": "object|array|string",
                "plan": "object|array|string",
                "action": "object|array|string",
                "weather": "object|array|string",
            },
            "markdown": "string",
        },
    },
    usage_contract=[
        "report_type 必须优先使用英文枚举值，不要把中文标题直接当 enum 传入",
        "situation_data、risk_data、weather_data 优先传对象，不建议传列表",
        "warning_data、plan_data、action_data 可传对象或列表，但对象更稳定",
        "extra_sections 必须表示为章节映射对象；若只有列表，请改写为 [{title, content}] 或 {章节名: 内容}",
        "若上游已有结构化结果，直接透传对象即可，不必再拼成长文本",
        "标题未提供时自动使用默认标题，缺失章节会显示“暂无数据”",
    ],
    examples=[
        {
            "input": {
                "report_type": "situation_report",
                "title": "南宁市防汛综合态势报告",
                "location": "南宁市",
                "situation_data": {
                    "summary": "全市出现持续强降雨，城区低洼点有积水。",
                    "focus_areas": ["西乡塘区", "良庆区", "邕江沿线"],
                },
                "warning_data": {
                    "warnings": [
                        {"title": "暴雨橙色预警", "issued_at": "2026-03-18 08:00"}
                    ]
                },
                "risk_data": {
                    "risk_level": "III",
                    "risk_label": "较大",
                    "risk_factors": ["短时强降雨", "河道水位上涨"],
                    "assessment": "需加强沿江和低洼地带巡查。"
                },
                "plan_data": {
                    "matched_plans": ["启动城区内涝防御预案", "加强排涝泵站值守"]
                },
                "action_data": {
                    "key_actions": ["加密会商研判", "预置抢险力量", "提醒群众避险"]
                },
                "weather_data": {
                    "rainfall_24h_mm": 86,
                    "forecast_rainfall_mm": 40,
                    "temp_c": 24
                },
                "extra_sections": {
                    "七、需协调事项": ["协调地铁站口挡水设施", "调拨排涝车辆"]
                },
                "report_time": "2026-03-18 09:30"
            },
            "result_hint": {
                "report_type": "situation_report",
                "markdown": "# 南宁市防汛综合态势报告"
            },
        },
        {
            "input": {
                "report_type": "flood_bulletin",
                "location": "桂林市",
                "situation_data": "{\"summary\":\"漓江水位上涨，部分乡镇出现积涝。\"}",
                "warning_data": "[{\"title\":\"暴雨黄色预警\",\"issued_at\":\"2026-03-18 07:20\"}]",
                "extra_sections": [
                    {"title": "七、值班安排", "content": "继续执行24小时值班值守。"}
                ]
            },
            "result_hint": {
                "report_type": "flood_bulletin",
                "title": "汛情快报"
            },
        },
    ],
)
def generate_report(
    report_type: str,
    title: str = None,
    location: str = "",
    situation_data=None,
    risk_data=None,
    warning_data=None,
    plan_data=None,
    action_data=None,
    weather_data=None,
    extra_sections=None,
    report_time: str = None,
    **kwargs,
):
    """生成标准格式应急报告。

    Args:
        report_type: 报告类型 flood_bulletin / disaster_report / situation_report
        title: 报告标题，不传则使用默认标题
        location: 区域
        situation_data: 态势/灾情数据（JSON 字符串或 dict）
        risk_data: 风险评估数据
        warning_data: 预警数据
        plan_data: 预案/建议数据
        action_data: 行动/响应数据
        weather_data: 气象数据
        extra_sections: 额外章节 {"章节名": "内容"}
        report_time: 报告时间，不传则使用当前时间

    Returns:
        ToolExecutionResult
    """
    report_type = _normalize_report_type(report_type)
    valid_types = list(_TEMPLATE_BUILDERS.keys())
    if report_type not in valid_types:
        return error_result(
            f"不支持的报告类型: {report_type}，可选: {', '.join(valid_types)}",
            tool_name="generate_report",
        )

    builder = _TEMPLATE_BUILDERS[report_type]
    report_title = title or _DEFAULT_TITLES[report_type]
    rtime = report_time or datetime.now().strftime("%Y-%m-%d %H:%M")

    situation = _safe_parse(situation_data)
    risk = _safe_parse(risk_data)
    warning = _safe_parse(warning_data)
    plan = _safe_parse(plan_data)
    action = _safe_parse(action_data)
    weather = _safe_parse(weather_data)
    extra = _normalize_extra_sections(_safe_parse(extra_sections))

    markdown_content = builder(
        title=report_title, location=location, report_time=rtime,
        situation=situation, risk=risk, warning=warning,
        plan=plan, action=action, weather=weather, extra=extra,
    )

    report_obj = {
        "report_type": report_type,
        "title": report_title,
        "location": location,
        "report_time": rtime,
        "sections": {
            "situation": situation,
            "risk": risk,
            "warning": warning,
            "plan": plan,
            "action": action,
            "weather": weather,
        },
        "markdown": markdown_content,
    }

    return success_result(
        content=report_obj,
        summary=f"已生成{report_title}（{location or '未指定区域'}）",
        tool_name="generate_report",
        output_type="markdown",
        llm_hint=f"报告已生成，请直接在 <final_answer> 中展示以下 Markdown 内容：\n\n{markdown_content}",
    )
