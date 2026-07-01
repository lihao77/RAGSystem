#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
action_checklist.py - 行动清单生成

将响应措施转换为带优先级、责任方和时限的可执行行动清单。
用法:
  python scripts/action_checklist.py --risk-level II --disaster-type 洪涝 --affected-area 南宁市
"""

import sys
import json
import argparse
from datetime import datetime


# 各级别的标准行动项模板
ACTION_TEMPLATES = {
    "I": {
        "immediate": [
            {"action": "启动I级应急响应，自治区防指总指挥到位主持会商", "responsible": "自治区防指", "deadline_hours": 1},
            {"action": "危险区域群众紧急转移安置", "responsible": "属地政府", "deadline_hours": 2},
            {"action": "请求国家防总和解放军/武警支援", "responsible": "自治区防指办", "deadline_hours": 1},
            {"action": "实施交通管制和重点区域封闭管理", "responsible": "公安交管部门", "deadline_hours": 1},
        ],
        "short_term": [
            {"action": "启用全部防洪工程和应急抢险队伍", "responsible": "水利部门", "deadline_hours": 4},
            {"action": "开放全部应急避难场所，安排生活保障", "responsible": "民政/应急部门", "deadline_hours": 4},
            {"action": "启动救灾物资紧急调运", "responsible": "应急物资保障部门", "deadline_hours": 6},
            {"action": "组织医疗救护队伍进驻灾区", "responsible": "卫健部门", "deadline_hours": 6},
        ],
        "ongoing": [
            {"action": "每1小时上报一次灾情信息", "responsible": "属地应急部门", "interval_hours": 1},
            {"action": "持续监测气象水文变化并更新预报", "responsible": "气象/水文部门", "interval_hours": 1},
            {"action": "保障通信和电力供应", "responsible": "通信/电力部门", "interval_hours": 2},
        ],
    },
    "II": {
        "immediate": [
            {"action": "启动II级应急响应，副总指挥到位主持会商", "responsible": "自治区防指", "deadline_hours": 2},
            {"action": "受威胁区域群众有序转移", "responsible": "属地政府", "deadline_hours": 4},
            {"action": "加强气象水文监测和预报预警", "responsible": "气象/水文部门", "deadline_hours": 2},
        ],
        "short_term": [
            {"action": "加强重要堤防和水库巡查防守", "responsible": "水利部门", "deadline_hours": 6},
            {"action": "预置抢险物资和救援力量", "responsible": "应急物资部门", "deadline_hours": 8},
            {"action": "发布公众防灾避险提示", "responsible": "宣传/应急部门", "deadline_hours": 4},
            {"action": "协调消防救援力量待命", "responsible": "消防部门", "deadline_hours": 4},
        ],
        "ongoing": [
            {"action": "每2小时上报一次灾情信息", "responsible": "属地应急部门", "interval_hours": 2},
            {"action": "持续跟踪降雨和水位变化", "responsible": "气象/水文部门", "interval_hours": 2},
        ],
    },
    "III": {
        "immediate": [
            {"action": "启动III级应急响应，秘书长到位会商", "responsible": "自治区防指", "deadline_hours": 4},
            {"action": "密切监视雨情水情发展态势", "responsible": "气象/水文部门", "deadline_hours": 4},
            {"action": "通知受威胁地区做好转移准备", "responsible": "属地政府", "deadline_hours": 6},
        ],
        "short_term": [
            {"action": "检查加固防洪工程薄弱环节", "responsible": "水利部门", "deadline_hours": 6},
            {"action": "核查应急物资储备和抢险队伍", "responsible": "应急部门", "deadline_hours": 8},
            {"action": "指导受威胁地区做好防范准备", "responsible": "自治区防指办", "deadline_hours": 8},
        ],
        "ongoing": [
            {"action": "每3小时上报一次灾情信息", "responsible": "属地应急部门", "interval_hours": 3},
        ],
    },
    "IV": {
        "immediate": [
            {"action": "启动IV级应急响应，加强值班", "responsible": "自治区防指办", "deadline_hours": 6},
            {"action": "关注天气形势和水情变化", "responsible": "气象/水文部门", "deadline_hours": 6},
        ],
        "short_term": [
            {"action": "提醒相关地区注意防范", "responsible": "自治区防指办", "deadline_hours": 12},
            {"action": "检查防洪排涝设施运行状况", "responsible": "水利/住建部门", "deadline_hours": 12},
        ],
        "ongoing": [
            {"action": "每6小时上报一次灾情信息", "responsible": "属地应急部门", "interval_hours": 6},
        ],
    },
}

PRIORITY_LABELS = {"immediate": "紧急", "short_term": "短期", "ongoing": "持续"}


def generate_checklist(args):
    """生成行动清单。"""
    risk_level = args.risk_level.upper()
    if risk_level not in ACTION_TEMPLATES:
        return {"success": False, "error": f"无效风险等级: {risk_level}"}

    template = ACTION_TEMPLATES[risk_level]
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    checklist = {
        "risk_level": risk_level,
        "disaster_type": args.disaster_type,
        "affected_area": args.affected_area,
        "generated_at": now,
        "total_actions": 0,
        "phases": {},
    }

    item_id = 0
    for phase, actions in template.items():
        phase_items = []
        for action_def in actions:
            item_id += 1
            item = {
                "id": item_id,
                "priority": PRIORITY_LABELS.get(phase, phase),
                "action": action_def["action"],
                "responsible": action_def["responsible"],
                "status": "待执行",
            }
            if "deadline_hours" in action_def:
                item["deadline"] = f"响应启动后 {action_def['deadline_hours']} 小时内"
            if "interval_hours" in action_def:
                item["frequency"] = f"每 {action_def['interval_hours']} 小时"

            if args.affected_area:
                item["action"] = item["action"].replace("受威胁区域", args.affected_area)
                item["action"] = item["action"].replace("受威胁地区", args.affected_area)

            phase_items.append(item)

        checklist["phases"][phase] = {
            "label": PRIORITY_LABELS.get(phase, phase),
            "items": phase_items,
        }

    checklist["total_actions"] = item_id

    # 文本格式输出
    if args.format == "text":
        lines = [f"# {risk_level}级应急响应行动清单 - {args.disaster_type}"]
        if args.affected_area:
            lines.append(f"受影响区域: {args.affected_area}")
        lines.append(f"生成时间: {now}")
        lines.append("")
        for phase, phase_data in checklist["phases"].items():
            lines.append(f"## {phase_data['label']}行动")
            for item in phase_data["items"]:
                deadline = item.get("deadline", item.get("frequency", ""))
                lines.append(f"  [{item['status']}] {item['id']}. {item['action']}")
                lines.append(f"       责任方: {item['responsible']}  时限: {deadline}")
            lines.append("")
        checklist["text_output"] = "\n".join(lines)

    return checklist


def main():
    parser = argparse.ArgumentParser(description="行动清单生成")
    parser.add_argument("--risk-level", required=True, help="风险等级 I/II/III/IV")
    parser.add_argument("--disaster-type", default="洪涝", help="灾害类型")
    parser.add_argument("--affected-area", default=None, help="受影响区域")
    parser.add_argument("--format", default="json", choices=["json", "text"], help="输出格式")
    args = parser.parse_args()

    result = generate_checklist(args)
    json.dump({"success": True, "data": result}, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
