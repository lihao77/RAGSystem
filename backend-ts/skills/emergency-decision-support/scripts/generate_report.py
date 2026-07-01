#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
generate_report.py - 应急报告生成

将态势、风险、预警、预案、行动等结构化结果汇总为标准 Markdown 报告。

用法:
  python generate_report.py --report-type situation_report --location 南宁市 \
    --situation-data '{"summary":"全市出现持续强降雨"}' \
    --risk-data '{"risk_level":"III","risk_label":"较大"}'
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from typing import Any


def _safe_parse(value) -> Any:
    """安全解析 JSON 字符串为 dict/list，已是结构化对象则直接返回。"""
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


def _format_warnings(warning) -> str:
    """格式化预警数据为文本。"""
    if not warning:
        return ""
    warnings = warning.get("warnings", []) if isinstance(warning, dict) else []
    if isinstance(warning, list):
        warnings = warning
    if not warnings:
        stat = warning.get("stat", {}) if isinstance(warning, dict) else {}
        if stat:
            return f"当前预警统计: {json.dumps(stat, ensure_ascii=False)}"
        return ""
    lines = []
    for item in warnings[:10]:
        if not isinstance(item, dict):
            lines.append(str(item))
            continue
        line = item.get("title", "")
        if item.get("issued_at"):
            line += f" ({item['issued_at']})"
        lines.append(line)
    return "\n".join(f"- {line}" for line in lines)


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
            parts.append("风险因素: " + "、".join(str(item) for item in factors))
    if risk.get("assessment"):
        parts.append(f"评估结论: {risk['assessment']}")
    return "\n\n".join(parts) if parts else str(risk)


def _build_flood_bulletin(
    title: str,
    location: str,
    report_time: str,
    situation: dict,
    risk: dict,
    warning,
    plan,
    action,
    weather: dict,
    extra: dict,
) -> str:
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
        items = action.get("key_actions") or action.get("actions") or action.get("measures") if isinstance(action, dict) else action
        action_text = items if isinstance(items, list) else str(action)
    md += _section("五、已采取措施", action_text)
    md += "\n"
    plan_text = ""
    if plan:
        if isinstance(plan, dict):
            plan_text = plan.get("suggestions") or plan.get("next_steps") or plan.get("recommendations") or str(plan)
        else:
            plan_text = str(plan)
    md += _section("六、下一步建议", plan_text)
    if extra:
        for key, value in extra.items():
            md += "\n" + _section(key, value)
    return md


def _build_disaster_report(
    title: str,
    location: str,
    report_time: str,
    situation: dict,
    risk: dict,
    warning,
    plan,
    action,
    weather: dict,
    extra: dict,
) -> str:
    del risk, warning, weather
    md = f"# {title}\n\n"
    md += f"**报告时间：** {report_time}　**区域：** {location}\n\n---\n\n"
    md += _section("一、灾情概述", situation.get("summary") or situation.get("description") or (str(situation) if situation else ""))
    md += "\n"
    affected = situation.get("affected") or situation.get("casualties") or situation.get("damage")
    md += _section("二、受灾情况", str(affected) if affected else "")
    md += "\n"
    response = action.get("response") or action.get("emergency_response") or "" if isinstance(action, dict) else ""
    if not response and action:
        response = str(action)
    md += _section("三、应急响应", response)
    md += "\n"
    rescue = action.get("rescue") or action.get("progress") or "" if isinstance(action, dict) else ""
    md += _section("四、救援进展", rescue)
    md += "\n"
    needs = plan.get("needs") or plan.get("requirements") or plan.get("demand_list") or "" if isinstance(plan, dict) else plan
    if isinstance(needs, dict):
        needs = "\n".join(f"- {key}: {value}" for key, value in needs.items())
    md += _section("五、需求清单", needs)
    if extra:
        for key, value in extra.items():
            md += "\n" + _section(key, value)
    return md


def _build_situation_report(
    title: str,
    location: str,
    report_time: str,
    situation: dict,
    risk: dict,
    warning,
    plan,
    action,
    weather: dict,
    extra: dict,
) -> str:
    md = f"# {title}\n\n"
    md += f"**报告时间：** {report_time}　**区域：** {location}\n\n---\n\n"
    overview = situation.get("summary") or situation.get("overview") or (str(situation) if situation else "")
    md += _section("一、态势概览", overview)
    md += "\n"
    md += _section("二、气象预警", _format_warnings(warning))
    md += "\n"
    focus = situation.get("focus_areas") or situation.get("key_areas") or ""
    if isinstance(focus, list):
        focus = "\n".join(f"- {item}" for item in focus)
    md += _section("三、重点区域分析", focus if focus else _format_weather(weather))
    md += "\n"
    md += _section("四、风险研判", _format_risk(risk))
    md += "\n"
    plan_text = ""
    if plan:
        if isinstance(plan, dict):
            plan_text = plan.get("matched_plans") or plan.get("plan_references") or str(plan)
        else:
            plan_text = plan
        if isinstance(plan_text, list):
            plan_text = "\n".join(
                f"- {item}" if isinstance(item, str) else f"- {item.get('text', str(item))}"
                for item in plan_text
            )
    md += _section("五、预案匹配", plan_text)
    md += "\n"
    action_text = ""
    if action:
        if isinstance(action, dict):
            items = action.get("key_actions") or action.get("suggestions") or action.get("recommendations")
            action_text = items if isinstance(items, list) else str(action)
        else:
            action_text = str(action)
    md += _section("六、行动建议", action_text)
    if extra:
        for key, value in extra.items():
            md += "\n" + _section(key, value)
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


def main() -> None:
    parser = argparse.ArgumentParser(description="应急报告生成")
    parser.add_argument("--report-type", required=True, help="报告类型：flood_bulletin / disaster_report / situation_report")
    parser.add_argument("--title", default=None, help="报告标题")
    parser.add_argument("--location", default="", help="区域")
    parser.add_argument("--situation-data", default=None, help="态势/灾情主数据 JSON")
    parser.add_argument("--risk-data", default=None, help="风险评估数据 JSON")
    parser.add_argument("--warning-data", default=None, help="预警数据 JSON")
    parser.add_argument("--plan-data", default=None, help="预案/建议数据 JSON")
    parser.add_argument("--action-data", default=None, help="行动/响应数据 JSON")
    parser.add_argument("--weather-data", default=None, help="气象数据 JSON")
    parser.add_argument("--extra-sections", default=None, help="额外章节 JSON")
    parser.add_argument("--report-time", default=None, help="报告时间，格式 YYYY-MM-DD HH:MM")
    args = parser.parse_args()

    report_type = _normalize_report_type(args.report_type)
    valid_types = list(_TEMPLATE_BUILDERS.keys())
    if report_type not in valid_types:
        print(
            json.dumps(
                {
                    "success": False,
                    "error": f"不支持的报告类型: {report_type}，可选: {', '.join(valid_types)}",
                },
                ensure_ascii=False,
            )
        )
        sys.exit(1)

    builder = _TEMPLATE_BUILDERS[report_type]
    report_title = args.title or _DEFAULT_TITLES[report_type]
    report_time = args.report_time or datetime.now().strftime("%Y-%m-%d %H:%M")

    situation = _safe_parse(args.situation_data)
    risk = _safe_parse(args.risk_data)
    warning = _safe_parse(args.warning_data)
    plan = _safe_parse(args.plan_data)
    action = _safe_parse(args.action_data)
    weather = _safe_parse(args.weather_data)
    extra = _normalize_extra_sections(_safe_parse(args.extra_sections))

    markdown_content = builder(
        title=report_title,
        location=args.location,
        report_time=report_time,
        situation=situation,
        risk=risk,
        warning=warning,
        plan=plan,
        action=action,
        weather=weather,
        extra=extra,
    )

    report_obj = {
        "report_type": report_type,
        "title": report_title,
        "location": args.location,
        "report_time": report_time,
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

    print(
        json.dumps(
            {
                "success": True,
                "data": report_obj,
                "summary": f"已生成{report_title}（{args.location or '未指定区域'}）",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
