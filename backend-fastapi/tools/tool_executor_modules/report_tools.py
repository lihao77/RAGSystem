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
from typing import Optional

from tools.response_builder import success_result, error_result


def _safe_parse(value) -> dict:
    """安全解析 JSON 字符串为 dict/list，已是 dict/list 则直接返回。"""
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
    extra = _safe_parse(extra_sections)

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
